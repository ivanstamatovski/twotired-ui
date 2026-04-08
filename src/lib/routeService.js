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

  const res = await fetch(EDGE_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + supabaseAnonKey },
    body: JSON.stringify({ start: 'Balancero Astoria', destination })
  });

  if (!res.ok) throw new Error('Route generation failed');
  const { routes } = await res.json();
  return { routes, source: 'generated' };
}

export async function saveRoute(routeId, userId) {
  return supabase.from('user_saved_routes').insert({ route_id: routeId, user_id: userId });
}

export async function submitBugReport({ userId, routeId, comment, imageData }) {
  return supabase.from('bug_reports').insert({ user_id: userId, route_id: routeId, comment, image_data: imageData });
}

export async function logRouteRequest(requestText, email) {
  return supabase.from('route_requests').insert({ request_text: requestText, email, status: 'pending' });
}
