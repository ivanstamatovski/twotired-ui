import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const EDGE_FN = supabaseUrl + '/functions/v1/generate-route';

export async function getRoutes(destination) {
  if (!destination || !destination.trim()) return { routes: [], source: 'empty' };

  const { data: cached, error } = await supabase
    .from('routes')
    .select('*')
    .ilike('destination', '%' + destination + '%')
    .eq('is_stale', false)
    .order('community_score', { ascending: false });

  if (!error && cached && cached.length > 0) {
    return { routes: cached, source: 'cache' };
  }

  return { routes: [], source: 'none' };
}

export async function saveRoute(routeId, userId) {
  return supabase.from('user_saved_routes').insert({ route_id: routeId, user_id: userId });
}

export async function submitBugReport({ userId, routeId, comment, imageData, pageContext }) {
  // Convert base64 PNG → Blob and upload to Storage, then store the public URL
  let screenshotUrl = null;

  if (imageData) {
    try {
      // Convert dataURL to Blob
      const res = await fetch(imageData);
      const blob = await res.blob();

      // Unique filename: timestamp + random suffix
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('bug-screenshots')
        .upload(filename, blob, { contentType: 'image/jpeg', upsert: false });

      if (uploadError) {
        console.error('Screenshot upload failed:', uploadError.message);
      } else {
        const { data: { publicUrl } } = supabase.storage
          .from('bug-screenshots')
          .getPublicUrl(filename);
        screenshotUrl = publicUrl;
      }
    } catch (err) {
      console.error('Screenshot processing failed:', err.message);
    }
  }

  // Use RPC function to bypass RLS (SECURITY DEFINER runs as postgres owner)
  return supabase.rpc('insert_bug_report', {
    p_comment: comment,
    p_screenshot_url: screenshotUrl,
    p_page_context: pageContext ?? null,
    p_user_id: userId ?? null,
    p_route_id: routeId ?? null,
  });
}

export async function logRouteRequest(requestText, email) {
  return supabase.from('route_requests').insert({ request_text: requestText, email, status: 'pending' });
}
