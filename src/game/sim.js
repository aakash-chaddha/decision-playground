// Pure deterministic simulation. All player inputs must be supplied by the caller.
export const schema = {
  movement: {type:'enum', choices:['up','down','left','right','stay'], description:'Approach using GLOBAL positions, not aim direction: enemy x greater than yours -> right; smaller -> left; enemy y greater -> down; smaller -> up. Choose an unblocked direction; stay if movement is unnecessary. Dodge incoming bullets when threatened.'},
  turn_dir: {type:'enum', choices:['left','right','hold'], description:'Choose left, right, or hold to aim toward the enemy using your heading and both global positions. Independent of movement direction.'},
  turn_angle: {type:'integer', minimum:0, maximum:90, description:'Choose how far to rotate toward the enemy: integer 0..90 degrees. Zero holds aim. Relative rotation, not global heading.'},
  fire: {type:'boolean', description:'Fire when the enemy is within 10 degrees of your facing direction, using global positions and your heading; otherwise false. No autoaim.'},
  stance: {type:'enum', choices:['stand','jump','crouch'], description:'Stand normally. Jump to dodge an incoming bullet only when milliseconds_until_can_jump is 0. Crouch when a smaller hitbox helps; it slows movement.'}
};
export const idle = () => ({movement:'stay', turn_dir:'hold', turn_angle:0, fire:false, stance:'stand'});
export function validateControls(c) {
  if (!c || Object.keys(c).length !== 5 || !Object.entries(schema).every(([k,v]) => v.type === 'boolean' ? typeof c[k] === 'boolean' : v.type === 'integer' ? Number.isInteger(c[k]) && c[k]>=v.minimum && c[k]<=v.maximum : v.choices.includes(c[k]))) throw new Error('Invalid five-field controls');
  return {...c};
}
export function createState({scenario='stationary',seed=7}={}) {
  let n=seed>>>0; n=(Math.imul(n,1664525)+1013904223)>>>0;
  return {width:800,height:500,seed,scenario,time:0,ticks:0,status:'playing',
    player:{x:150,y:250,yaw:0,hp:100,r:12,cooldown:0,jump:0,jumpCooldown:0,stance:'stand',turn_remaining_degrees:0},
    enemy:{x:610,y:270+(n%15),yaw:180,hp:100,r:scenario==='duel'?12:15,cooldown:scenario==='duel'?0:1.2,jump:0,jumpCooldown:0,stance:'stand',turn_remaining_degrees:0,dir:n%2?1:-1},
    obstacles:[{x:340,y:65,w:65,h:115},{x:340,y:330,w:65,h:105}],
    bullets:[],shots:0,hits:0,misses:0,enemyShots:0,enemyHits:0,enemyMisses:0,controls:idle(),enemyControls:idle(),events:[]};
}
export const create = createState;
export const state = createState;
export function applyControls(s,c,enemyControls) {
  const player=validateControls(c);
  const enemy=s.scenario==='duel'?validateControls(enemyControls):null;
  s.controls=player;s.player.turn_remaining_degrees=player.turn_dir==='hold'?0:player.turn_angle;
  if(enemy){s.enemyControls=enemy;s.enemy.turn_remaining_degrees=enemy.turn_dir==='hold'?0:enemy.turn_angle;}
  // Opt-in (s.moveSeconds): a movement command lasts this long, then the agent stops until the next command.
  // Unset keeps the original behaviour: movement is held until replaced.
  if(s.moveSeconds!=null){s.player.move_remaining=s.moveSeconds;if(enemy)s.enemy.move_remaining=s.moveSeconds;}
  return s;
}
const movementVectors = {up:[0,-1],down:[0,1],left:[-1,0],right:[1,0],stay:[0,0]};
const rad = d => d*Math.PI/180;
const wrap = d => ((d+180)%360+360)%360-180;
function blocked(s,x,y,r) {
  return x<r || y<r || x>s.width-r || y>s.height-r || s.obstacles.some(o => Math.hypot(x-Math.max(o.x,Math.min(x,o.x+o.w)),y-Math.max(o.y,Math.min(y,o.y+o.h)))<r);
}
function move(s,a,dx,dy) {
  if(!blocked(s,a.x+dx,a.y,a.r)) a.x+=dx;
  if(!blocked(s,a.x,a.y+dy,a.r)) a.y+=dy;
}
function event(s,message){s.events.push({time:+s.time.toFixed(2),message});if(s.events.length>30)s.events.shift();}
// Slab intersection: returns first impact fraction along a segment.
function rectHit(x,y,dx,dy,o) {
  let lo=0,hi=1;
  for(const [p,d,a,b] of [[x,dx,o.x,o.x+o.w],[y,dy,o.y,o.y+o.h]]) {
    if(Math.abs(d)<1e-9){if(p<a||p>b)return Infinity;continue;}
    const t1=(a-p)/d,t2=(b-p)/d;lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));
    if(lo>hi)return Infinity;
  }return lo;
}
function circleHit(b,dx,dy,a) {
  const x=b.x-a.x,y=b.y-a.y,A=dx*dx+dy*dy,B=2*(x*dx+y*dy),C=x*x+y*y-a.r*a.r;
  if(C<=0)return 0;const disc=B*B-4*A*C;if(disc<0||!A)return Infinity;
  const t=(-B-Math.sqrt(disc))/(2*A);return t>=0&&t<=1?t:Infinity;
}
export function lineOfSight(s) {const p=s.player,e=s.enemy;return !s.obstacles.some(o=>rectHit(p.x,p.y,e.x-p.x,e.y-p.y,o)!==Infinity);}
function shoot(s,a,owner) {
  s.bullets.push({x:a.x,y:a.y,vx:Math.cos(rad(a.yaw))*420,vy:Math.sin(rad(a.yaw))*420,owner});a.cooldown=owner==='player'||s.scenario==='duel'?.4:1.1;
  if(owner==='player'){s.shots++;event(s,'Player shot');}else{s.enemyShots++;if(s.scenario==='duel')event(s,'Red shot');}
}
export function update(s,dt=.2) {
  if(!Number.isFinite(dt)||dt<=0||dt>1)throw new Error('dt must be in (0,1]');
  if(s.status!=='playing')return s;
  const c=validateControls(s.controls),p=s.player,e=s.enemy;
  const agents=[[p,c,'player']];
  if(s.scenario==='duel')agents.push([e,validateControls(s.enemyControls),'enemy']);
  for(const [a,input,owner] of agents){
    a.stance=input.stance;a.r=input.stance==='crouch'?8:12;
    if(input.stance==='jump'&&a.jumpCooldown<=0){a.jump=.3;a.jumpCooldown=1.5;event(s,owner==='player'?'Jump dodge':'Red jump dodge');}
  }
  const steps=Math.ceil(dt/(1/120)),h=dt/steps;
  for(let i=0;i<steps&&s.status==='playing';i++) {
    s.time+=h;
    for(const a of [p,e])a.cooldown=Math.max(0,a.cooldown-h);
    for(const [a,input] of agents){
      a.jump=Math.max(0,a.jump-h);a.jumpCooldown=Math.max(0,a.jumpCooldown-h);
      const rotation=Math.min(a.turn_remaining_degrees,90*h);
      a.yaw=wrap(a.yaw+(input.turn_dir==='left'?-1:input.turn_dir==='right'?1:0)*rotation);
      a.turn_remaining_degrees=Math.max(0,a.turn_remaining_degrees-rotation);
      const [dx,dy]=movementVectors[input.movement],speed=(input.stance==='crouch'?52:105)*h;
      if(s.moveSeconds==null||a.move_remaining>0){move(s,a,dx*speed,dy*speed);if(s.moveSeconds!=null)a.move_remaining=Math.max(0,a.move_remaining-h);}
    }
    // Scripted opponent only. It never sets player controls.
    if(s.scenario==='combat') {
      if(e.y<100)e.dir=1;if(e.y>400)e.dir=-1;
      move(s,e,0,e.dir*65*h);e.yaw=Math.atan2(p.y-e.y,p.x-e.x)*180/Math.PI;
      if(e.cooldown<=0&&lineOfSight(s))shoot(s,e,'enemy');
    }
    for(const [a,input,owner] of agents)if(input.fire&&a.cooldown<=0)shoot(s,a,owner);
    s.bullets=s.bullets.filter(b=>{
      const dx=b.vx*h,dy=b.vy*h,target=b.owner==='player'?e:p;
      let wall=Infinity;
      for(const o of s.obstacles)wall=Math.min(wall,rectHit(b.x,b.y,dx,dy,o));
      // World boundary impact, compared against target impact.
      if(dx>0)wall=Math.min(wall,(s.width-b.x)/dx);else if(dx<0)wall=Math.min(wall,-b.x/dx);
      if(dy>0)wall=Math.min(wall,(s.height-b.y)/dy);else if(dy<0)wall=Math.min(wall,-b.y/dy);
      const hit=(target.jump>0)?Infinity:circleHit(b,dx,dy,target);
      if(hit<=1&&hit<wall){target.hp=Math.max(0,target.hp-20);if(b.owner==='player')s.hits++;else s.enemyHits++;event(s,`${b.owner==='player'?'Target':'Player'} hit (−20)`);return false;}
      if(wall<=1){if(b.owner==='player'){s.misses++;event(s,'Player miss: wall / cover');}else s.enemyMisses++;return false;}
      b.x+=dx;b.y+=dy;return true;
    });
    if(p.hp<=0||e.hp<=0){s.status=s.scenario==='duel'&&p.hp<=0&&e.hp<=0?'draw':p.hp<=0?'lost':'won';s.controls=idle();s.enemyControls=idle();p.turn_remaining_degrees=0;e.turn_remaining_degrees=0;event(s,s.status==='draw'?'Draw':s.status==='won'?'Target defeated':'Player defeated');}
  }
  s.ticks++;return s;
}
export function buildObservation(s,dt=.2,actor='player'){
  if(!['player','enemy'].includes(actor))throw new Error('Unknown actor');
  const own=s[actor],enemy=s[actor==='player'?'enemy':'player'],round=n=>Math.round(n)||0;
  const travel=(own.stance==='crouch'?52:105)*dt,steps=Math.max(1,Math.ceil(travel/2));
  const movementBlocked={};
  for(const direction of ['up','down','left','right']){
    const [dx,dy]=movementVectors[direction];movementBlocked[direction]=false;
    for(let i=1;i<=steps;i++)if(blocked(s,own.x+dx*travel*i/steps,own.y+dy*travel*i/steps,own.r)){movementBlocked[direction]=true;break;}
  }
  const incoming=s.bullets.filter(b=>b.owner!==actor).sort((a,b)=>Math.hypot(a.x-own.x,a.y-own.y)-Math.hypot(b.x-own.x,b.y-own.y));
  const pose=a=>({world_x_pixels:round(a.x),world_y_pixels:round(a.y),heading_degrees:round(((a.yaw%360)+360)%360)%360,health:round(a.hp)});
  return {
    your_state:{...pose(own),remaining_turn_degrees:round(own.turn_remaining_degrees),milliseconds_until_can_fire:round(own.cooldown*1000),dodge_milliseconds_remaining:round(own.jump*1000),milliseconds_until_can_jump:round(own.jumpCooldown*1000),
      held_controls:{...(actor==='player'?s.controls:s.enemyControls),...(s.moveSeconds!=null&&!(own.move_remaining>0)?{movement:'stay'}:{})}},
    enemy_state:{world_x_pixels:round(enemy.x),world_y_pixels:round(enemy.y)},
    movement_blocked:movementBlocked,incoming_bullet_count:incoming.length,
    nearest_incoming_bullet:incoming.length?{world_x_pixels:round(incoming[0].x),world_y_pixels:round(incoming[0].y),velocity_x_px_s:round(incoming[0].vx),velocity_y_px_s:round(incoming[0].vy)}:null
  };
}
export function serializePreviousTransition(previous){
  return previous?{observation:previous.observation,action_applied:previous.action_applied,observed_at_ms:Math.round(previous.observed_at*1000),action_applied_at_ms:Math.round(previous.action_applied_at*1000)}:null;
}
export const DEFAULT_AGENT_INSTRUCTIONS = 'Choose controls to defeat the target and survive.\nTurn toward target; hold when aligned. Fire when the enemy is within 10 degrees of your facing direction. Approach if far; choose a clear global movement direction. Stand by default without threats. No autoaim.';
export function buildContext(s,dt=.2,actor='player',{previous=null,step=false,instructions=DEFAULT_AGENT_INSTRUCTIONS}={}){
  const observation=buildObservation(s,dt,actor),p=observation.your_state,e=observation.enemy_state;
  const facts=previous?JSON.stringify({previous:serializePreviousTransition(previous),current:{observation,observed_at_ms:Math.round(s.time*1000)}}):
    `You (the character choosing controls): world position (pixels) x=${p.world_x_pixels}, y=${p.world_y_pixels}; heading=${p.heading_degrees} degrees; health=${p.health}. Milliseconds until can fire=${p.milliseconds_until_can_fire}; dodge milliseconds remaining=${p.dodge_milliseconds_remaining}; milliseconds until can jump=${p.milliseconds_until_can_jump}. Turn degrees remaining=${p.remaining_turn_degrees}; applied controls=${JSON.stringify(p.held_controls)}.
Enemy (other character): world position (pixels) x=${e.world_x_pixels}, y=${e.world_y_pixels}.
Movement blocked=${JSON.stringify(observation.movement_blocked)}. Incoming count=${observation.incoming_bullet_count}; nearest=${JSON.stringify(observation.nearest_incoming_bullet)}. Sim time=${Math.round(s.time*1000)}ms.`;
  return `${instructions}
World: x right,y down; headings 0 right,90 down,180 left,270 up. You=controlled actor. Current overrides history.
${step?`Apply for ${Math.round(dt*1000)}ms.`:`Refresh requested ${Math.round(dt*1000)}ms; controls held until response.`} turn_dir selects direction; turn_angle=integer 0..90 relative degrees. Choose turning from your heading and global positions. Hold/0 cancels; turn once at90deg/s then stop; newest replaces remainder. Move105/crouch52px/s; dodge300ms jump cooldown1500ms; gun cooldown400ms unlimited.
Arena width,height=${Math.round(s.width)},${Math.round(s.height)} pixels. Solid cover (world x,y,width,height)=${JSON.stringify(s.obstacles.map(o=>[o.x,o.y,o.w,o.h].map(Math.round)))}.
${facts}`;
}

// Stable headless entry points; state is mutable and returned by stepGame.
export const DECISION_SCHEMA = schema;
export function createGame(scenario='stationary',seed=7) { return createState({scenario,seed}); }
export function stepGame(state,controls,dt=.2,enemyControls) {
  // Validate the complete pair before mutating either set of controls.
  const player=validateControls(controls);
  const enemy=state.scenario==='duel'?validateControls(enemyControls):null;
  if(!Number.isFinite(dt)||dt<=0||dt>1)throw new Error('dt must be in (0,1]');
  if(state.status!=='playing')return state;
  applyControls(state,player,enemy);
  return update(state,dt);
}
