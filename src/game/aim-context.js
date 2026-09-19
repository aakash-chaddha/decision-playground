import {buildObservation,serializePreviousTransition,DECISION_SCHEMA,DEFAULT_AGENT_INSTRUCTIONS} from './sim.js';
export const LAYA_SCHEMA={...DECISION_SCHEMA,turn_dir:{...DECISION_SCHEMA.turn_dir,description:'Compare enemy bearing_degrees with your heading. Choose the shortest turn: left decreases heading, right increases it; hold when aligned. Angles wrap at 360.'},fire:{...DECISION_SCHEMA.fire,description:'Fire when the smallest angular difference between your heading and enemy bearing_degrees is less than 10 degrees; otherwise false.'},stance:{...DECISION_SCHEMA.stance,description:DECISION_SCHEMA.stance.description.replace('milliseconds_until_can_jump','jump_cooldown_ms')},turn_angle:{type:'enum',choices:['0','5','15','30','60','90'],description:'Choose the closest available angle to the smallest angular difference between your heading and enemy bearing_degrees, capped at 90. Choose 0 when aligned. Relative turn amount, not global bearing.'}};
export function enemyBearing(s,actor='player') {
 const self=s[actor],enemy=s[actor==='player'?'enemy':'player'];
 const dx=enemy.x-self.x,dy=enemy.y-self.y;
 if(dx===0&&dy===0)return {bearing_degrees:null,screen_direction:'same_position'};
 const bearing=(Math.atan2(dy,dx)*180/Math.PI+360)%360;
 const directions=['right','down-right','down','down-left','left','up-left','up','up-right'];
 return {bearing_degrees:Math.round(bearing)%360,screen_direction:directions[Math.round(bearing/45)%8]};
}
export function aimDeviation(s,actor='player') {
 const self=s[actor],enemy=s[actor==='player'?'enemy':'player'];
 const dx=enemy.x-self.x,dy=enemy.y-self.y;
 const signed=dx===0&&dy===0?0:((Math.atan2(dy,dx)*180/Math.PI-self.yaw)%360+540)%360-180;
 const degrees=Math.round(Math.abs(signed));
 return {aim_deviation_degrees:degrees,aim_deviation_direction:degrees===0?'center':signed===-180?'right':signed<0?'left':'right'};
}
export function buildLayaContext(s,dt=.2,actor='player',{instructions=DEFAULT_AGENT_INSTRUCTIONS,previous=null}={}){
 const o=buildObservation(s,dt,actor),p=o.your_state;
 const current={you:{x:p.world_x_pixels,y:p.world_y_pixels,heading:p.heading_degrees,health:p.health,fire_cooldown_ms:p.milliseconds_until_can_fire,jump_cooldown_ms:p.milliseconds_until_can_jump,dodge_ms:p.dodge_milliseconds_remaining,turn_remaining:p.remaining_turn_degrees},enemy:{x:o.enemy_state.world_x_pixels,y:o.enemy_state.world_y_pixels,...enemyBearing(s,actor)},movement_blocked:o.movement_blocked,incoming_bullets:o.incoming_bullet_count,nearest_bullet:o.nearest_incoming_bullet};
 return `${instructions}\nGlobal pixels: right +x, left -x, up -y, down +y. Heading: 0 right,90 down,180 left,270 up. Left turn decreases heading; right increases it. Enemy bearing_degrees is the global angle from you to enemy; screen_direction is its nearest compass direction. Movement independent of heading. Turn once, hold cancels. Arena ${s.width}x${s.height}; cover rectangles x,y,w,h=${JSON.stringify(s.obstacles.map(o=>[o.x,o.y,o.w,o.h]))}.\n${JSON.stringify(previous?{previous:serializePreviousTransition(previous),current}:current)}`;
}
