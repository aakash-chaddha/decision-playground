// Column definitions are sent in the cached static prompt; all values remain in
// the per-tick observation. This changes serialization, not game information.
export const COMPACT_LEGEND=`Observation rows below use these column orders (commas separate values):
you: x,y,heading,health,fire_cooldown_ms,jump_cooldown_ms,dodge_ms,turn_remaining.
enemy: x,y,bearing_degrees,screen_direction; null bearing means coincident positions.
blocked: up,down,left,right; 1 means blocked, 0 means clear.
bullets: incoming_bullets count.
nearest: world_x_pixels,world_y_pixels,velocity_x_px_s,velocity_y_px_s; none means no incoming bullet.
aim: aim_deviation_degrees,aim_deviation_direction (only present when enabled).
All positions, headings, timers and turn amounts retain the units defined above.`;
// Column order of each compact row. Builds the rows sent to the model and labels them in the UI.
export const COMPACT_COLUMNS={
  you:['x','y','heading','health','fire_cooldown_ms','jump_cooldown_ms','dodge_ms','turn_remaining'],
  enemy:['x','y','bearing_degrees','screen_direction'],
  blocked:['up','down','left','right'],
  bullets:['incoming_bullets'],
  nearest:['world_x_pixels','world_y_pixels','velocity_x_px_s','velocity_y_px_s'],
  aim:['aim_deviation_degrees','aim_deviation_direction']
};
export function mojoContext(text, compact=true) {
  const split=text.lastIndexOf('\n{');
  const fixed=text.slice(0,split),dynamic=text.slice(split+1);
  if(!compact)return {static_context:fixed,context:dynamic};
  const [stateLine,...rest]=dynamic.split('\n');
  const s=JSON.parse(stateLine);
  // Previous-transition envelopes remain in their original explicit form.
  if(s.previous)return {static_context:fixed,context:dynamic};
  const p=s.you,e=s.enemy,b=s.nearest_bullet;
  const rows=[
    'you:'+COMPACT_COLUMNS.you.map(k=>p[k]).join(','),
    'enemy:'+COMPACT_COLUMNS.enemy.map(k=>e[k]===null?'null':e[k]).join(','),
    'blocked:'+COMPACT_COLUMNS.blocked.map(k=>Number(s.movement_blocked[k])).join(','),
    'bullets:'+s.incoming_bullets,
    'nearest:'+(b?COMPACT_COLUMNS.nearest.map(k=>b[k]).join(','):'none')
  ];
  if(rest.length&&rest[0].startsWith('Relative enemy aim deviation: ')){
    const a=JSON.parse(rest[0].slice('Relative enemy aim deviation: '.length));
    rows.push('aim:'+COMPACT_COLUMNS.aim.map(k=>a[k]).join(','));
  }
  return {static_context:fixed+'\n'+COMPACT_LEGEND,context:rows.join('\n')};
}
