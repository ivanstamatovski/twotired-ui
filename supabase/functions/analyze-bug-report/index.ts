// analyze-bug-report edge function — v1.1
// Called by admin portal when a bug report detail panel is opened.
// Fetches the report + route context, asks Claude Haiku (with vision) to write
// a specific routing lesson, saves it back to bug_reports.proposed_lesson.
// v1.1: uses route_context JSONB (escape_waypoint, intermediates, etc.) + image_data
//       as a vision input so Haiku can see exactly what went wrong on the map.
// Input: POST { bug_report_id: string }
// Output: { success: true, proposed_lesson: string }

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { bug_report_id } = await req.json();
    if (!bug_report_id) {
      return new Response(JSON.stringify({ error: 'bug_report_id required' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the bug report — include route_context and image_data (v1.1)
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bug_reports?id=eq.${bug_report_id}&select=comment,page_context,proposed_lesson,lesson_approved,route_context,image_data`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!fetchRes.ok) throw new Error(`Fetch bug report failed: ${fetchRes.status}`);
    const rows: any[] = await fetchRes.json();
    if (!rows.length) throw new Error(`Bug report not found: ${bug_report_id}`);

    const report = rows[0];

    // If already analyzed and approved, just return existing lesson
    if (report.lesson_approved === true && report.proposed_lesson) {
      return new Response(JSON.stringify({ success: true, proposed_lesson: report.proposed_lesson, already_approved: true }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // If already analyzed (pending review), return existing proposed lesson without re-running
    if (report.proposed_lesson && report.lesson_approved === null) {
      return new Response(JSON.stringify({ success: true, proposed_lesson: report.proposed_lesson, already_analyzed: true }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Need to generate a lesson
    if (!report.comment || report.comment.trim().length < 5) {
      return new Response(JSON.stringify({ error: 'Bug report has no meaningful comment to analyze' }), {
        status: 422, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── Build rich route context string ──────────────────────────────────────
    const ctx = report.route_context;
    let routeContextBlock = '';
    if (ctx) {
      const parts: string[] = [];
      if (ctx.title) parts.push(`Route title: "${ctx.title}"`);
      if (ctx.destination_query || ctx.destination) {
        parts.push(`Destination: ${ctx.destination_query || ctx.destination}`);
      }
      if (ctx.origin_query) parts.push(`Origin: ${ctx.origin_query}`);
      if (ctx.distance_mi) parts.push(`Distance: ${Number(ctx.distance_mi).toFixed(1)} mi`);
      if (ctx.duration_str) parts.push(`Duration: ${ctx.duration_str}`);
      if (ctx.escape_waypoint) parts.push(`Escape waypoint: ${ctx.escape_waypoint}`);
      if (ctx.escape_via_waypoints?.length) {
        parts.push(`Escape via: ${ctx.escape_via_waypoints.join(' → ')}`);
      }
      if (ctx.intermediate_waypoints?.length) {
        parts.push(`Intermediate waypoints: ${ctx.intermediate_waypoints.join(' → ')}`);
      }
      if (ctx.curviness) parts.push(`Curviness tier: ${ctx.curviness}`);
      if (parts.length > 0) {
        routeContextBlock = `\n\nRoute context:\n${parts.map((p) => `  • ${p}`).join('\n')}`;
      }
    }

    const queryContext = report.page_context
      ? `\nOriginal query: "${report.page_context}"`
      : '';

    // ── Build Claude message — use vision if image_data available ─────────────
    // image_data is stored as a full data URI: "data:image/jpeg;base64,..."
    const imageData = report.image_data;
    const hasImage = imageData && typeof imageData === 'string' && imageData.startsWith('data:image/');

    let messageContent: any[];
    if (hasImage) {
      // Strip the data URI prefix to get raw base64
      const commaIdx = imageData.indexOf(',');
      const base64Data = commaIdx !== -1 ? imageData.slice(commaIdx + 1) : imageData;
      const mediaType = imageData.slice(5, commaIdx).split(';')[0] || 'image/jpeg';

      messageContent = [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64Data },
        },
        {
          type: 'text',
          text: `Rider complaint: "${report.comment.trim()}"${queryContext}${routeContextBlock}\n\nThe screenshot above shows the map view the rider was looking at when they filed this report (they may have zoomed in on the problem area).`,
        },
      ];
    } else {
      messageContent = [
        {
          type: 'text',
          text: `Rider complaint: "${report.comment.trim()}"${queryContext}${routeContextBlock}`,
        },
      ];
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `You are a routing quality reviewer for TwoTired, a motorcycle ride planning app for the Northeast US.

A rider submitted a complaint about a generated route. You have been given:
- Their complaint text
- The original route query
- The routing parameters Claude used (escape waypoint, intermediate waypoints, etc.)
- A map screenshot the rider captured (if available) showing the problematic section

Your job is to write ONE specific, actionable routing lesson that will prevent this exact mistake from happening again.

Rules for the lesson:
- 1–2 sentences maximum. Be precise.
- Name the specific mistake using actual place names from the context (e.g. "routing through Fort Lee residential streets", "placing a waypoint past the destination", "using GWB instead of Verrazzano for Staten Island destinations").
- State the fix as a concrete routing rule (e.g. "When destined for Hawks Nest, use Harriman as the escape waypoint, not GWB").
- Reference the actual escape_waypoint or intermediate_waypoints from the context when they caused the problem.
- Do NOT write vague lessons like "avoid bad routes" or "improve route quality".
- Do NOT write about the app, the user experience, or anything unrelated to routing decisions.
- If the complaint + context still isn't specific enough to write a precise lesson, respond with exactly: INSUFFICIENT_DETAIL

Respond with ONLY the lesson text (or INSUFFICIENT_DETAIL). No preamble, no quotes, no explanation.`,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });

    if (!claudeRes.ok) throw new Error(`Claude call failed: ${claudeRes.status} ${await claudeRes.text()}`);
    const claudeData = await claudeRes.json();
    const proposedLesson = claudeData.content?.[0]?.text?.trim() || '';

    if (!proposedLesson || proposedLesson === 'INSUFFICIENT_DETAIL') {
      return new Response(JSON.stringify({ success: false, reason: 'INSUFFICIENT_DETAIL', message: 'Comment is too vague to extract a specific routing lesson.' }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Save proposed_lesson back to the bug report (lesson_approved stays null = pending)
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bug_reports?id=eq.${bug_report_id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ proposed_lesson: proposedLesson }),
      },
    );
    if (!patchRes.ok) throw new Error(`Save proposed lesson failed: ${patchRes.status}`);

    const mode = hasImage ? 'vision+context' : (routeContextBlock ? 'context-only' : 'comment-only');
    console.log(`[analyze-bug-report] saved lesson for ${bug_report_id} (mode: ${mode}): ${proposedLesson.slice(0, 80)}...`);

    return new Response(JSON.stringify({ success: true, proposed_lesson: proposedLesson }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[analyze-bug-report] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
