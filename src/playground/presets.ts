// Playground presets: each one is a complete decision request (instructions, schema, context).
// Sizes go from 3 fields to 30 so the gap between one scoring pass and token-by-token JSON shows.
export interface Preset { id: string; name: string; blurb: string; instructions: string; schema: Record<string, unknown>; context: string }
const e = (choices: string[], description: string) => ({type: 'enum', choices, description});
const b = (description: string) => ({type: 'boolean', description});
const int = (minimum: number, maximum: number, description: string) => ({type: 'integer', minimum, maximum, description});

function squad() {
  const schema: Record<string, unknown> = {};
  for (let u = 1; u <= 10; u++) {
    schema[`unit_${u}_order`] = e(['attack', 'move', 'hold', 'retreat', 'heal'], `Order for unit ${u}; follow the unit rules.`);
    schema[`unit_${u}_target`] = e(['none', 'E1', 'E2', 'E3', 'E4', 'E5', 'A', 'B', 'C', 'D'],
      `Enemy id when unit ${u} attacks, waypoint A-D when it moves or retreats, none when it holds or heals.`);
  }
  Object.assign(schema, {
    formation: e(['line', 'wedge', 'column', 'scatter'], 'wedge when attacking with most units, scatter under artillery fire, line when holding.'),
    stance: e(['aggressive', 'defensive', 'passive'], 'aggressive when we outnumber the visible enemy, defensive otherwise.'),
    build: e(['none', 'barracks', 'tower', 'refinery', 'hospital'], 'refinery when gold < 200; hospital when 3+ units are below 40 health; otherwise none.'),
    train: e(['none', 'soldier', 'archer', 'medic'], 'medic when no medic is alive; otherwise soldier if gold >= 100; otherwise none.'),
    rally_point: e(['A', 'B', 'C', 'D'], 'The waypoint closest to the enemy base.'),
    call_artillery: b('true only when 3 or more enemies stand at the same waypoint.'),
    use_smoke: b('true when any unit retreats.'),
    request_reinforcements: b('true when fewer than 6 of our units have health above 40.'),
    scout: e(['none', 'north', 'south', 'east', 'west'], 'The direction of the last known enemy sighting that no unit can see now; none if all are visible.'),
    alert_level: int(0, 5, 'Number of enemies within range of our base, capped at 5.'),
  });
  return schema;
}

export const PRESETS: Preset[] = [
  {
    id: 'arena', name: 'Arena combat · 5 fields',
    blurb: 'The game controller from the arena: aim, fire, move and dodge.',
    instructions: `Choose controls to defeat the enemy and survive.
fire: true whenever aim_deviation_degrees is 10 or less, even while turning; otherwise false.
turn_dir: aim_deviation_direction; hold only when aim_deviation_degrees is 0.
turn_angle: aim_deviation_degrees, capped at 90.
movement: approach the enemy along a clear direction when far; stay when close.
stance: stand unless a bullet is incoming; jump or crouch to evade it.
Global pixels: right +x, left -x, up -y, down +y. Heading: 0 right, 90 down, 180 left, 270 up.
Observation rows use these column orders:
you: x,y,heading,health,fire_cooldown_ms,jump_cooldown_ms
enemy: x,y,bearing_degrees,screen_direction
blocked: up,down,left,right (1 = blocked)
aim: aim_deviation_degrees,aim_deviation_direction`,
    schema: {
      movement: e(['up', 'down', 'left', 'right', 'stay'], 'Approach using global positions: enemy x greater than yours -> right; smaller -> left. Stay if movement is unnecessary.'),
      turn_dir: e(['left', 'right', 'hold'], 'Use aim_deviation_direction; hold only when aim_deviation_degrees is 0.'),
      turn_angle: int(0, 90, 'aim_deviation_degrees, capped at 90; 0 when aligned.'),
      fire: b('true when aim_deviation_degrees is 10 or less, even while turning; otherwise false.'),
      stance: e(['stand', 'jump', 'crouch'], 'Stand normally; jump or crouch only to dodge an incoming bullet.'),
    },
    context: `you:150,250,330,100,0,0
enemy:610,273,3,right
blocked:0,0,0,0
aim:33,right`,
  },
  {
    id: 'routing', name: 'Support ticket routing · 3 fields',
    blurb: 'State plus three questions: a choice, a yes/no and a priority score.',
    instructions: 'Answer each question about this support request from its state.',
    schema: {
      category: e(['billing', 'technical', 'cancellation', 'other'], 'What type of support request is this?'),
      urgent: b('Does this need urgent handling?'),
      priority: e(['low', 'medium', 'high', 'critical'], 'Rate support priority.'),
    },
    context: JSON.stringify({message: 'I was charged twice and need this fixed today.', customerPlan: 'Pro', accountAgeDays: 420}, null, 2),
  },
  {
    id: 'routing-bulk', name: 'Support ticket routing · 8 tickets in one request',
    blurb: 'The same three questions for eight tickets: one /v1/decision call against eight chat completions.',
    instructions: 'Answer each question about this support request from its state.',
    schema: {
      category: e(['billing', 'technical', 'cancellation', 'other'], 'What type of support request is this?'),
      urgent: b('Does this need urgent handling?'),
      priority: e(['low', 'medium', 'high', 'critical'], 'Rate support priority.'),
    },
    context: [
      { message: 'I was charged twice and need this fixed today.', customerPlan: 'Pro', accountAgeDays: 420 },
      { message: 'The dashboard has been down for our whole team since this morning.', customerPlan: 'Enterprise', accountAgeDays: 1210 },
      { message: 'How do I export my data to CSV?', customerPlan: 'Free', accountAgeDays: 12 },
      { message: 'Please cancel my subscription at the end of this month.', customerPlan: 'Pro', accountAgeDays: 95 },
      { message: 'Love the new charts, any plans for dark mode?', customerPlan: 'Pro', accountAgeDays: 300 },
      { message: 'API calls return 500 errors and our checkout is failing.', customerPlan: 'Enterprise', accountAgeDays: 640 },
      { message: 'My invoice shows the wrong company address.', customerPlan: 'Pro', accountAgeDays: 210 },
      { message: 'Cancel now or I will dispute the charge with my bank.', customerPlan: 'Free', accountAgeDays: 3 },
    ]
      .map((state) => JSON.stringify(state, null, 2))
      .join('\n---\n'),
  },
  {
    id: 'ticket', name: 'Support ticket triage · 12 fields',
    blurb: 'Route and label an inbound customer email.',
    instructions: `You triage customer support email for a SaaS product (plans: free, pro, enterprise).
priority: P1 = service down or data loss for a paying customer; P2 = a paying customer blocked on a feature; P3 = question or minor bug; P4 = feedback.
escalate_to: billing for charges and refunds, engineering for bugs and outages, legal for data or contract requests, none otherwise.
refund_eligible: charged within the last 30 days and the charge was a mistake or the service failed.
churn_risk: the customer threatens to cancel or mentions a competitor.
sla_hours: P1 = 1, P2 = 4, P3 = 24, P4 = 72.`,
    schema: {
      category: e(['billing', 'bug', 'outage', 'how_to', 'feature_request', 'account', 'data_request'], 'The main topic of the email.'),
      priority: e(['P1', 'P2', 'P3', 'P4'], 'Priority per the rules.'),
      sla_hours: e(['1', '4', '24', '72'], 'Response deadline that matches the priority.'),
      sentiment: e(['very_negative', 'negative', 'neutral', 'positive'], 'The customer\'s tone.'),
      plan: e(['free', 'pro', 'enterprise', 'unknown'], 'The customer\'s plan if stated or implied.'),
      escalate_to: e(['none', 'billing', 'engineering', 'legal'], 'Team to escalate to.'),
      refund_eligible: b('Per the refund rule.'),
      churn_risk: b('Per the churn rule.'),
      contains_pii: b('true if the email includes a card number, phone number or home address.'),
      language: e(['en', 'de', 'fr', 'es', 'other'], 'The language the email is written in.'),
      reply_tone: e(['apologetic', 'neutral', 'upbeat'], 'apologetic for negative sentiment, upbeat for positive, neutral otherwise.'),
      needs_human: b('true for P1, P2, legal or churn risk; false when an automated answer is enough.'),
    },
    context: `From: Maria Keller <m.keller@northwind-logistics.com>
Subject: Charged twice AND the export is broken — seriously?

Hi, we're on the Enterprise plan. On the 3rd you charged our card twice for the annual renewal ($4,800 each).
On top of that, since yesterday the CSV export returns an empty file for every report, so my team can't close the month.
If this isn't fixed this week we're moving to Acme Analytics. Call me at +1 415 555 0142.`,
  },
  {
    id: 'home', name: 'Smart home · 18 fields',
    blurb: 'A night routine for a whole house from one sentence and sensor state.',
    instructions: `You control a smart home. Apply the user's request to every device, using the sensor state.
Night routine: lights off everywhere except the hallway at 20% until 23:30 (then off); outdoor lights on motion; bedroom blinds closed;
living-room blinds closed; front door locked; garage closed; alarm in night mode; TV off; music stopped;
thermostat heat to 19 C when outdoor temperature is below 12 C, otherwise off.
Start the dishwasher only if it is loaded and it is after 22:00. Dock the robot vacuum at night.
Notify the user only when something could not be done or is unsafe (a window left open, a door that will not lock).`,
    schema: {
      living_lights: e(['off', 'dim', 'on'], 'Living room lights.'),
      kitchen_lights: e(['off', 'dim', 'on'], 'Kitchen lights.'),
      bedroom_lights: e(['off', 'dim', 'on'], 'Bedroom lights.'),
      hallway_brightness: {type: 'number', minimum: 0, maximum: 100, step: 10, description: 'Hallway brightness in percent.'},
      outdoor_lights: e(['off', 'motion', 'on'], 'Outdoor lights mode.'),
      living_blinds: e(['open', 'half', 'closed'], 'Living room blinds.'),
      bedroom_blinds: e(['open', 'half', 'closed'], 'Bedroom blinds.'),
      thermostat_mode: e(['off', 'heat', 'cool', 'auto'], 'Thermostat mode.'),
      target_temp_c: int(16, 28, 'Target temperature in Celsius.'),
      front_door: e(['locked', 'unlocked'], 'Front door lock.'),
      garage_door: e(['open', 'closed'], 'Garage door.'),
      alarm_mode: e(['disarmed', 'home', 'away', 'night'], 'Alarm mode.'),
      tv_on: b('Whether the TV stays on.'),
      music: e(['play', 'pause', 'stop'], 'Whole-home audio.'),
      start_dishwasher: b('Start the dishwasher now.'),
      robot_vacuum: e(['start', 'dock', 'idle'], 'Robot vacuum.'),
      notify_user: b('Send the user a notification.'),
      notify_reason: e(['none', 'window_open', 'door_jammed', 'device_offline'], 'Why the user is notified; none if not notified.'),
    },
    context: `User: "I'm heading to bed, get the house ready for the night."
time: 22:41
outdoor_temp_c: 8
sensors: kitchen_window=open, front_door=unlocked, garage=open
devices: tv=on, music=playing, dishwasher=loaded, robot_vacuum=cleaning
lights: living=on, kitchen=on, bedroom=dim, hallway=on`,
  },
  {
    id: 'rover', name: 'Warehouse robot · 10 fields',
    blurb: 'Obstacle, battery and task state to a motion command.',
    instructions: `You drive a warehouse robot on a grid. Obstacles block a direction when their distance is under 1.0 m.
Priorities: 1) avoid collisions, 2) dock to charge when battery < 20%, 3) finish the current task.
speed: 0 when stopped, 0.5 near people (under 3 m), otherwise 1.5 (m/s).
lift: raise only at a pickup shelf, lower only at the drop zone, otherwise hold.
beacon: flashing whenever moving near people, solid when stopped, off otherwise.`,
    schema: {
      direction: e(['north', 'south', 'east', 'west', 'stop'], 'Move toward the goal along an unblocked direction; stop if every useful direction is blocked.'),
      speed_mps: {type: 'number', minimum: 0, maximum: 1.5, step: 0.5, description: 'Speed per the rules.'},
      goal: e(['task', 'charger'], 'What the robot is heading to.'),
      lift: e(['raise', 'lower', 'hold'], 'Fork lift.'),
      beacon: e(['off', 'solid', 'flashing'], 'Warning beacon.'),
      horn: b('Sound the horn when a person is under 1.5 m in the travel direction.'),
      report_blocked: b('true when the direct direction to the goal is blocked.'),
      reroute: b('true when the robot takes a direction other than the direct one.'),
      battery_warning: b('true when battery is below 20%.'),
      eta_s: int(0, 120, 'Estimated seconds to the goal at the chosen speed (distance / speed, rounded, capped at 120; 0 when stopped).'),
    },
    context: `position: (12, 4)
task: pick up from shelf S7 at (12, 14), direct direction north, distance 10 m
charger: (0, 4), direction west, distance 12 m
battery: 64%
obstacles: north 0.6 m (pallet), west 0.8 m (rack), south 0.9 m (cart), east clear
the only way around the pallet is east
people: worker at 2.4 m east`,
  },
  {
    id: 'arm', name: 'Robot arm · JSON Schema · 8 fields',
    blurb: 'The same engine fed a standard JSON Schema with integer and multipleOf number fields.',
    instructions: `You command a 4-axis pick-and-place arm. Joint angles are in degrees; the gripper opening is in cm.
To pick an object: rotate the base to the object's bearing, lower the shoulder to the object's reach angle,
open the gripper 1 cm wider than the object's width, and keep the wrist level (0) unless the object is tilted
(then match its tilt). Speed: slow for fragile objects, normal otherwise.`,
    schema: {
      type: 'object',
      properties: {
        base_deg: {type: 'integer', minimum: -90, maximum: 90, description: 'Base rotation: the object bearing.'},
        shoulder_deg: {type: 'integer', minimum: 0, maximum: 90, description: 'Shoulder angle: the reach angle.'},
        wrist_deg: {type: 'integer', minimum: -45, maximum: 45, description: 'Wrist tilt: 0, or the object tilt.'},
        gripper_cm: {type: 'number', minimum: 0, maximum: 12, multipleOf: 0.5, description: 'Opening: object width + 1.'},
        speed: {enum: ['slow', 'normal'], description: 'slow when fragile.'},
        vacuum: {type: 'boolean', description: 'Use the suction cup instead of the gripper for flat objects under 0.5 cm thick.'},
        confirm_with_camera: {type: 'boolean', description: 'true when the object confidence is below 0.8.'},
        action: {enum: ['pick', 'wait', 'abort'], description: 'abort if the object is out of reach (bearing beyond +-90), wait if a person is in the cell.'},
      },
    },
    context: `object: glass vial, fragile
bearing: -32 deg, reach angle: 57 deg, tilt: 12 deg
width: 3.5 cm, thickness: 3.5 cm
detection confidence: 0.74
cell: no people`,
  },
  {
    id: 'squad', name: 'RTS squad commander · 30 fields',
    blurb: 'Orders for ten units plus base management: the big-JSON case.',
    instructions: `You command ten units in a real-time strategy game. Waypoints: A (our base, west), B (center), C (north ridge), D (enemy base, east).
Unit rules, applied in order:
1. A medic (units 3 and 8) heals when any unit at its waypoint is below 50 health; otherwise it holds.
2. Any unit below 25 health retreats to A.
3. A unit attacks the weakest visible enemy at its own waypoint.
4. A unit with no enemy at its waypoint moves to the waypoint with the most enemies.
5. Otherwise it holds.`,
    schema: squad(),
    context: `gold: 140
enemy base distance from our base: far
units (id,type,health,waypoint):
1,soldier,90,B
2,soldier,20,B
3,medic,70,B
4,archer,65,C
5,archer,15,C
6,soldier,100,A
7,soldier,80,B
8,medic,95,A
9,archer,35,C
10,soldier,55,B
enemies (id,health,waypoint): E1,60,B  E2,30,B  E3,90,C  E4,100,B  E5,45,B
enemies within range of our base: 1
last sighting not visible now: none`,
  },
];
