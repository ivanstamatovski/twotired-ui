import { supabase } from './supabase.js';

export async function getRoutes(destination) {
  if (!destination || !destination.trim()) return { routes: [], source: 'empty' };

  const query = destination.trim().toLowerCase();

  const { data, error } = await supabase
    .from('routes')
    .select('*')
    .eq('is_stale', false)
    .order('community_score', { ascending: false });

  if (error) {
    console.error('[getRoutes] Supabase error:', error.message);
    return { routes: [], source: 'error' };
  }

  const matches = (data || []).filter(r =>
    (r.title && r.title.toLowerCase().includes(query)) ||
    (r.destination && r.destination.toLowerCase().includes(query)) ||
    (r.group_name && r.group_name.toLowerCase().includes(query)) ||
    (r.desc && r.desc.toLowerCase().includes(query))
  );

  return { routes: matches, source: matches.length > 0 ? 'cache' : 'miss' };
}

export async function submitBugReport({ userId, routeId, comment, imageData, pageContext }) {
  const { error } = await supabase.from('bug_reports').insert([{
    user_id: userId ?? null,
    route_id: routeId ?? null,
    comment: comment || '',
    image_data: imageData ?? null,
    page_context: pageContext ?? null,
    created_at: new Date().toISOString(),
  }]);

  if (error) throw new Error(error.message);
}

export async function saveRoute(routeId, userId) {
  if (!routeId || !userId) return;

  const { error } = await supabase.from('saved_routes').upsert([{
    route_id: routeId,
    user_id: userId,
    saved_at: new Date().toISOString(),
  }], { onConflict: 'route_id,user_id' });

  if (error) console.error('[saveRoute] error:', error.message);
}

export async function logRouteRequest({ destination, userId }) {
  const { error } = await supabase.from('route_requests').insert([{
    destination: destination || '',
    user_id: userId ?? null,
    created_at: new Date().toISOString(),
  }]);

  if (error) console.error('[logRouteRequest] error:', error.message);
}
