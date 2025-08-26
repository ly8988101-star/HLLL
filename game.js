// Glabat Al-Hams - 3D Horror Game for Android Browsers using Three.js
// Arabic narrative integrated with gameplay. Organized, commented code.

/* =========================================================
   Bootstrapping and Globals
   ========================================================= */
const App = {
  version: '1.0.0',
  state: 'menu', // 'menu' | 'intro' | 'vision' | 'playing' | 'paused' | 'gameover' | 'ending'
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  clock: new THREE.Clock(),
  dpr: Math.min(window.devicePixelRatio || 1, 1.5), // lower DPR for Android perf
  input: {
    move: { x: 0, y: 0 },
    look: { dx: 0, dy: 0 },
    draggingLook: false
  },
  ui: {},
  settings: { sensitivity: 1.0, quality: 'medium', masterVolume: 0.9 },
  saveKey: 'forest_whisper_save_v1',
  rng: (() => { // lightweight RNG for procedural placement
    let seed = 1337;
    return {
      setSeed(s){ seed = s >>> 0; },
      next(){ seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }
    };
  })()
};

/* =========================================================
   Utility helpers
   ========================================================= */
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t){ return a + (b - a) * t; }
function vec2len(x, y){ return Math.sqrt(x*x + y*y); }

/* =========================================================
   Audio Manager
   - Ambient drone, footsteps, monster proximity cue
   ========================================================= */
const AudioManager = {
  context: null,
  masterGain: null,
  isMuted: false,
  buffers: {},
  footstepCooldown: 0,
  _ambientHandle: null,
  breathTimer: 0,
  whisperTimer: 0,

  async init(){
    if(this.context) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.context = new Ctx();
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = App.settings.masterVolume;
    this.masterGain.connect(this.context.destination);

    // Generate simple procedural sounds to avoid external assets
    this.buffers.ambient = this.createDroneBuffer(40, 120);
    this.buffers.step = this.createNoiseTapBuffer(0.09);
    this.buffers.monster = this.createHowlBuffer(0.8);
    this.buffers.breath = this.createBreathBuffer(1.2);
    this.buffers.whisper = this.createWhisperBuffer(0.9);
  },

  resume(){ this.context && this.context.resume(); },
  muteToggle(){ this.isMuted = !this.isMuted; this.masterGain.gain.value = this.isMuted ? 0.0 : App.settings.masterVolume; return this.isMuted; },

  playBuffer(buf, {loop=false, gain=1.0, rate=1.0} = {}){
    if(!this.context) return null;
    const src = this.context.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.context.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.masterGain);
    src.loop = loop;
    src.start();
    return { src, gain: g };
  },

  createDroneBuffer(minHz = 50, maxHz = 120){
    const sr = 48000, dur = 8; // seconds
    const buf = this.context.createBuffer(2, sr * dur, sr);
    for(let ch=0; ch<2; ch++){
      const data = buf.getChannelData(ch);
      let phase = 0, freq = minHz, dt = 1/sr;
      for(let i=0;i<data.length;i++){
        // slowly wander frequency
        const t = i / data.length;
        const target = minHz + (maxHz-minHz) * (0.5 + 0.5*Math.sin(2*Math.PI*t*0.2 + (ch?1.2:0)));
        freq = lerp(freq, target, 0.0008);
        phase += 2*Math.PI*freq*dt;
        const s = Math.sin(phase) * 0.25 + Math.sin(phase*0.5)*0.15;
        // subtle noisy texture
        const n = (Math.random()*2-1)*0.02;
        data[i] = (s + n) * (0.9 - 0.7*Math.abs(0.5 - t));
      }
    }
    return buf;
  },

  createNoiseTapBuffer(dur = 0.08){
    const sr = 44100, len = Math.max(1, Math.floor(sr * dur));
    const buf = this.context.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    let value = 0;
    for(let i=0;i<len;i++){
      // brownish noise step
      value += (Math.random()*2-1) * 0.02;
      value *= 0.98;
      const env = Math.pow(1 - i/len, 3);
      data[i] = value * env * 0.9;
    }
    return buf;
  },

  createHowlBuffer(dur = 1.0){
    const sr = 44100, len = Math.max(1, Math.floor(sr * dur));
    const buf = this.context.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    let phase = 0, freq = 140;
    for(let i=0;i<len;i++){
      const t = i/len;
      const target = 80 + 80*Math.sin(t*4*Math.PI);
      freq = lerp(freq, target, 0.02);
      phase += 2*Math.PI*freq/sr;
      const env = Math.sin(Math.min(1, t)*Math.PI);
      const s = Math.sin(phase) * env * (0.4 + 0.3*Math.sin(t*10));
      data[i] = s;
    }
    return buf;
  }
};

// تأكيد تشغيل صوت الجو العام باستمرار خلال اللعب حتى لو بدأ اللاعب من التحميل مباشرةً
AudioManager.ensureAmbient = async function(){
  await this.init();
  this.resume();
  if(!this._ambientHandle){
    this._ambientHandle = this.playBuffer(this.buffers.ambient, { loop:true, gain:0.6 });
  }
};

// تنفس متسارع عند انخفاض الجهد
AudioManager.createBreathBuffer = function(dur = 1.2){
  const sr = 44100, len = Math.max(1, Math.floor(sr * dur));
  const buf = this.context.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  let val = 0;
  for(let i=0;i<len;i++){
    val += (Math.random()*2-1) * 0.02; // brown noise
    val *= 0.98;
    const t = i/len;
    const env = Math.sin(Math.min(1, t)*Math.PI); // in-out
    data[i] = val * env * 0.7;
  }
  return buf;
};

// همسات تظهر مع قلة العقل أو قرب الوحش
AudioManager.createWhisperBuffer = function(dur = 0.9){
  const sr = 44100, len = Math.max(1, Math.floor(sr * dur));
  const buf = this.context.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for(let i=0;i<len;i++){
    const t = i/len;
    const n = (Math.random()*2-1);
    const band = Math.sin(2*Math.PI*1200*i/sr)*0.4 + Math.sin(2*Math.PI*900*i/sr)*0.3;
    const env = Math.pow(1 - Math.abs(0.5 - t)*2, 2);
    data[i] = (n*0.15 + band*0.1) * env;
  }
  return buf;
};

/* =========================================================
   Story Manager (Arabic)
   - Controls intro text, cryptic vision, progressive reveals, ending
   ========================================================= */
const StoryManager = {
  introParagraphs: [
    // تمهيد (يرتبط بالانميشن اللاحق: دائرة الأشجار والوميض الأخضر ترمز لفم الغابة الذي يلتهم الأسماء)
    "تحت قمر مشقوق، استيقظت على همس يُنادي اسمك، لكن الاسم بدا غريباً… كما لو أن الغابة نطقت به قبلك.",
    "رأيتُ دائرة من الأشجار تُغلق، ووميضاً أخضر يلتهم ظلَّك، ثم سكون.\nعندما فتحت عينيك مجدداً، كان الطريق خلفك يبتلع أثر خطواتك.",
    "يقولون إن الغابة تقتات على كلماتنا. إن تكلّمتَ كثيراً، جاعت أكثر… وإن صمتَّ طويلاً، نسيتَ اسمك." 
  ],
  endingTextSurvive: [
    "كانت الدائرة هي فمُ الغابة. الوميض الأخضر كان شهيّتها. كل دليل جمعته كان حرفاً من اسمك تُعيده إلى صوتك.",
    "حين اكتمل الاسم، انفرجت الجذوع وخرج الهمس من حنجرتك كزفير أخير… وظهر الطريق.",
    "نجوت. لكن الغابة لا تُغلق فمها. هناك أسماء أخرى ما زالت تُنادى." 
  ],
  endingTextDeath: [
    "تأخرتَ. دائرتُها أطبقت، وصار اسمك وجبةً جديدة. الوميضُ الأخضر لم يكن سوى آخر ما تبقّى منك.",
    "في ظلامها، يسكن همسٌ جديدٌ بصوتك.\nالطريق كان موجوداً… لكنه لا ينتظر طويلاً.",
  ],

  typeNode: null,
  skipButton: null,
  visionOverlay: null,
  endingNode: null,
  typing: false,

  init(){
    this.typeNode = document.getElementById('intro-text');
    this.skipButton = document.getElementById('btn-skip-intro');
    this.visionOverlay = document.getElementById('vision-overlay');
    this.endingNode = document.getElementById('ending-text');
    this.skipButton.addEventListener('click', ()=>{ this.finishIntro(); });
  },

  async runIntro(){
    const intro = document.getElementById('intro-overlay');
    intro.classList.add('visible');
    this.typeNode.textContent = '';
    await AudioManager.init();
    AudioManager.resume();

    // Play ambient background
    this._ambient = AudioManager.playBuffer(AudioManager.buffers.ambient, { loop: true, gain: 0.6 });

    for(const p of this.introParagraphs){
      await this.typeArabic(p, 22);
      await this.wait(700);
    }
    await this.wait(400);
    this.finishIntro();
  },

  async typeArabic(text, cps = 28){
    this.typing = true;
    this.typeNode.textContent = '';
    const chars = Array.from(text);
    for(let i=0;i<chars.length;i++){
      this.typeNode.textContent += chars[i];
      await this.wait(1000 / cps);
      if(!this.typing) return; // skipped
    }
  },

  finishIntro(){
    this.typing = false;
    const intro = document.getElementById('intro-overlay');
    intro.classList.remove('visible');
    this.playVision();
  },

  async playVision(){
    const v = this.visionOverlay;
    v.classList.add('visible');
    // Subtle monster cue during vision
    AudioManager.playBuffer(AudioManager.buffers.monster, { gain: 0.4, rate: 0.9 });
    await this.wait(3600);
    v.classList.remove('visible');
    GameFlow.startGameplay();
  },

  async showEnding(survived){
    const overlay = document.getElementById('ending');
    overlay.classList.add('visible');
    const lines = survived ? this.endingTextSurvive : this.endingTextDeath;
    this.endingNode.textContent = '';
    for(const p of lines){
      await this.typeEnding(p, 22);
      await this.wait(600);
    }
  },

  async typeEnding(text, cps=26){
    const node = this.endingNode;
    node.textContent = '';
    const chars = Array.from(text);
    for(const ch of chars){ node.textContent += ch; await this.wait(1000/cps); }
  },

  wait(ms){ return new Promise(res => setTimeout(res, ms)); }
};

/* =========================================================
   Three.js Forest Scene
   - Ground plane, fog, instanced trees/rocks, subtle lighting
   ========================================================= */
const Forest = {
  group: new THREE.Group(),
  bounds: 250, // half-extent
  treeCount: 450,
  rockCount: 120,
  trees: null,
  rocks: null,
  clueItems: [],
  portal: null,
  portalActive: false,

  init(){
    App.scene.add(this.group);
    // Foggy night
    App.scene.fog = new THREE.FogExp2(0x07080a, 0.018);

    // Ground
    const groundGeo = new THREE.CircleGeometry(this.bounds*1.2, 64);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x0b1316, roughness: 1.0, metalness: 0.0 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI/2;
    ground.receiveShadow = true;
    this.group.add(ground);

    // Lighting
    const hemi = new THREE.HemisphereLight(0x32424a, 0x060708, 0.2);
    App.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xa3f1ce, 0.25);
    dir.position.set(80, 120, -60);
    dir.castShadow = false;
    App.scene.add(dir);

    // Instanced trees
    this.trees = this.createTrees();
    this.group.add(this.trees);
    // Instanced rocks
    this.rocks = this.createRocks();
    this.group.add(this.rocks);

    // Clues (glowing orbs) - 5 items
    this.spawnClues(5);

    // Exit portal (locked until all clues)
    this.portal = this.createPortal();
    this.group.add(this.portal);
  },

  createTrees(){
    const trunkGeo = new THREE.CylinderGeometry(0.4, 0.7, 10, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x1b1e20, roughness: 0.9 });
    const leavesGeo = new THREE.ConeGeometry(2.6, 8, 8);
    const leavesMat = new THREE.MeshStandardMaterial({ color: 0x0f2622, roughness: 1 });

    const count = this.treeCount;
    const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0,0,0), trunkMat, count*2);
    // We'll not use instanced cylinder; instead build group with two instanced meshes for perf
    const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const leafInst = new THREE.InstancedMesh(leavesGeo, leavesMat, count);
    trunkInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    leafInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.Matrix4();
    let i = 0;
    while(i < count){
      const r = App.rng.next();
      const x = (r*2-1) * this.bounds;
      const z = (App.rng.next()*2-1) * this.bounds;
      const dist = Math.sqrt(x*x + z*z);
      if(dist < 12) continue; // keep spawn area open
      const rot = App.rng.next() * Math.PI*2;
      const scale = 0.8 + App.rng.next()*0.7;
      mat.compose(new THREE.Vector3(x, 5, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), rot), new THREE.Vector3(1,1,1));
      trunkInst.setMatrixAt(i, mat);
      mat.compose(new THREE.Vector3(x, 10, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), rot), new THREE.Vector3(scale, scale, scale));
      leafInst.setMatrixAt(i, mat);
      i++;
    }
    trunkInst.frustumCulled = true;
    leafInst.frustumCulled = true;
    const g = new THREE.Group();
    g.add(trunkInst);
    g.add(leafInst);
    return g;
  },

  createRocks(){
    const rockGeo = new THREE.DodecahedronGeometry(1.5, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x1a2224, roughness: 1 });
    const count = this.rockCount;
    const inst = new THREE.InstancedMesh(rockGeo, rockMat, count);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const mat = new THREE.Matrix4();
    for(let i=0;i<count;i++){
      const x = (App.rng.next()*2-1) * this.bounds;
      const z = (App.rng.next()*2-1) * this.bounds;
      const y = 0.5 + App.rng.next() * 0.8;
      const s = 0.8 + App.rng.next() * 1.8;
      mat.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), App.rng.next()*Math.PI*2), new THREE.Vector3(s, s*0.7, s));
      inst.setMatrixAt(i, mat);
    }
    return inst;
  },

  spawnClues(n){
    for(let i=0;i<n;i++){
      const x = (App.rng.next()*2-1) * (this.bounds-30);
      const z = (App.rng.next()*2-1) * (this.bounds-30);
      const orb = this.createGlowingOrb(0x5fd1a6);
      orb.position.set(x, 1.6 + App.rng.next()*0.5, z);
      orb.userData.isClue = true;
      orb.userData.index = i;
      // أدلة مضيئة: كل واحدة تمثل ومضة من الاسم المفقود، تُستخدم لسرد القصة تدريجياً
      this.group.add(orb);
      this.clueItems.push(orb);
    }
  },

  createGlowingOrb(color){
    const geo = new THREE.SphereGeometry(0.35, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color, transparent:true, opacity:0.9 });
    const m = new THREE.Mesh(geo, mat);
    const light = new THREE.PointLight(color, 0.9, 9, 1.8);
    light.position.y = 0.2;
    m.add(light);
    return m;
  },

  createPortal(){
    const g = new THREE.TorusGeometry(2.8, 0.25, 16, 64);
    const m = new THREE.MeshBasicMaterial({ color: 0x58e0b4, transparent:true, opacity:0.2 });
    const torus = new THREE.Mesh(g, m);
    torus.position.set(0, 2.5, -this.bounds + 18);
    const pl = new THREE.PointLight(0x58e0b4, 0.0, 16);
    torus.add(pl);
    torus.userData.isPortal = true;
    // البوابة = فم الغابة الذي ينغلق/ينفتح بحسب اكتمال الاسم (جمع الأدلة)
    return torus;
  },

  setPortalActive(active){
    this.portalActive = active;
    const pl = this.portal.children.find(c => c.isLight);
    if(active){
      this.portal.material.opacity = 0.7;
      if(pl) pl.intensity = 1.6;
    } else {
      this.portal.material.opacity = 0.2;
      if(pl) pl.intensity = 0.0;
    }
  },

  update(dt, time){
    // Idle animations
    for(const orb of this.clueItems){
      const t = time * 0.8 + orb.userData.index;
      orb.position.y = 1.4 + Math.sin(t) * 0.25;
      orb.rotation.y += dt * 0.8;
    }
    this.portal.rotation.z += dt*0.5;
  }
};

/* =========================================================
   Player Controller and Camera
   - Mobile joystick move, touch-look, collision with trees/bounds
   ========================================================= */
const Player = {
  holder: new THREE.Object3D(),
  speed: 6.0,
  baseSpeed: 6.0,
  sprintSpeed: 9.0,
  crouchSpeed: 3.5,
  velocity: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  cameraHeight: 1.7,
  colliderRadius: 0.8,
  stamina: 1.0,
  sanity: 1.0,
  torchOn: false,
  crouching: false,
  sprinting: false,
  torchLight: null,

  init(){
    App.scene.add(this.holder);
    App.camera.position.set(0, this.cameraHeight, 6);
    this.holder.position.set(0, 0, 0);
    this.yaw = Math.PI; // face portal initially
    // Torch light (spotlight simplified as point light for perf)
    const light = new THREE.PointLight(0xfff3d1, 0.0, 12, 1.9);
    App.camera.add(light);
    this.torchLight = light;
  },

  getPosition(){ return this.holder.position; },

  update(dt){
    // Input from virtual joystick
    const moveX = App.input.move.x; // strafe
    const moveY = App.input.move.y; // forward
    const moveLen = vec2len(moveX, moveY);
    let forward = 0, strafe = 0;
    if(moveLen > 0.05){
      const n = 1; // already normalized in joystick
      forward = moveY * n; strafe = moveX * n;
    }
    // Update yaw/pitch from look input
    const sens = App.settings.sensitivity;
    this.yaw -= App.input.look.dx * 0.0035 * sens;
    this.pitch -= App.input.look.dy * 0.0025 * sens;
    this.pitch = clamp(this.pitch, -1.0, 1.0);
    App.input.look.dx = 0; App.input.look.dy = 0;

    // Movement in world aligned with yaw
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const dirX = (forward * sin + strafe * cos);
    const dirZ = (forward * cos - strafe * sin);
    // Adjust speed by state
    let currentSpeed = this.baseSpeed;
    if(this.sprinting && this.stamina > 0.25) currentSpeed = this.sprintSpeed;
    if(this.crouching) currentSpeed = this.crouchSpeed;
    this.velocity.set(dirX, 0, dirZ).multiplyScalar(currentSpeed);
    this.holder.position.x += this.velocity.x * dt;
    this.holder.position.z += this.velocity.z * dt;

    // Collision: world bounds
    const b = Forest.bounds - 2;
    this.holder.position.x = clamp(this.holder.position.x, -b, b);
    this.holder.position.z = clamp(this.holder.position.z, -b, b);

    // Collision: avoid trees (approx by projecting against leaf instanced positions)
    // Simplified: radial push from center ring to simulate density
    const pos = this.holder.position;
    const d = Math.sqrt(pos.x*pos.x + pos.z*pos.z);
    if(d < 8){ // keep from center objects
      const push = (8 - d) * 0.08;
      if(d > 0.0001){ pos.x -= (pos.x/d) * push; pos.z -= (pos.z/d) * push; }
    }

    // Camera follow
    const camHeight = this.crouching ? this.cameraHeight * 0.7 : this.cameraHeight;
    App.camera.position.copy(this.holder.position).add(new THREE.Vector3(0, camHeight, 0));
    App.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    // Torch intensity
    this.torchLight.intensity = this.torchOn ? 1.0 : 0.0;
    this.torchLight.distance = this.torchOn ? 12 : 0.0;

    // Stamina drain/recover
    if(this.sprinting && moveLen > 0.05){ this.stamina -= dt * 0.22; }
    else { this.stamina += dt * 0.16; }
    this.stamina = clamp(this.stamina, 0, 1);
    if(this.stamina <= 0.02) this.sprinting = false;

    // Sanity affected by monster proximity (closer monster -> faster drain), torch helps slightly
    const proximity = Monster.proximity || 999;
    const fear = Math.max(0, 1 - proximity/30);
    const torchMitigate = this.torchOn ? 0.4 : 1.0;
    this.sanity -= dt * fear * 0.06 * torchMitigate;
    this.sanity += dt * 0.012; // slow recovery
    this.sanity = clamp(this.sanity, 0, 1);

    // Update HUD bars and FX
    UIHud.updateBars(this.stamina, this.sanity);
  }
};

/* =========================================================
   Monster AI
   - Surprise appearances, proximity cue, game over when close
   ========================================================= */
const Monster = {
  mesh: null,
  lastSpawnTime: 0,
  spawnInterval: 7.5,
  speed: 3.2,
  active: true,
  proximity: 999,
  howlTimer: 0,
  state: 'lurking', // 'lurking' | 'hunting' | 'vanish' | 'illusion'
  illusionMesh: null,

  init(){
    const geo = new THREE.ConeGeometry(1.2, 3.2, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0d1417, emissive: 0x081a14, emissiveIntensity: 0.2, roughness: 1 });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false;
    m.position.set(0, 1.6, -Forest.bounds + 30);
    this.mesh = m;
    App.scene.add(m);

    // Illusion: faint ghost that flickers to mislead
    const ig = new THREE.ConeGeometry(0.8, 2.2, 5);
    const im = new THREE.MeshBasicMaterial({ color: 0x58e0b4, transparent:true, opacity:0.1 });
    this.illusionMesh = new THREE.Mesh(ig, im);
    this.illusionMesh.position.set(6, 1.1, 6);
    this.illusionMesh.visible = false;
    App.scene.add(this.illusionMesh);
  },

  update(dt, time){
    if(!this.active) return;
    const playerPos = Player.getPosition();

    // State switching
    if(time - this.lastSpawnTime > this.spawnInterval){
      this.lastSpawnTime = time;
      const roll = App.rng.next();
      if(roll < 0.2){ this.state = 'illusion'; }
      else if(roll < 0.7){ this.state = 'lurking'; }
      else { this.state = 'hunting'; }

      // Reposition behind trees
      const angle = App.rng.next() * Math.PI * 2;
      const dist = 18 + App.rng.next() * 24;
      this.mesh.position.set(playerPos.x + Math.sin(angle)*dist, 1.6, playerPos.z + Math.cos(angle)*dist);
      // Illusion spawn elsewhere
      const ia = angle + Math.PI * 0.7;
      const id = dist * (0.6 + App.rng.next()*0.5);
      this.illusionMesh.position.set(playerPos.x + Math.sin(ia)*id, 1.2, playerPos.z + Math.cos(ia)*id);
      this.illusionMesh.visible = (this.state === 'illusion');
    }

    // Chase towards player when within 36 units
    const dx = playerPos.x - this.mesh.position.x;
    const dz = playerPos.z - this.mesh.position.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    this.proximity = dist;
    if(this.state !== 'illusion' && dist < 36){
      const vx = (dx / Math.max(0.001, dist)) * this.speed;
      const vz = (dz / Math.max(0.001, dist)) * this.speed;
      this.mesh.position.x += vx * dt;
      this.mesh.position.z += vz * dt;
    }

    // Monster sound gets louder when close
    if(AudioManager.context){
      this.howlTimer -= dt;
      if(this.howlTimer <= 0 && dist < 18){
        this.howlTimer = 3 + App.rng.next()*3;
        AudioManager.playBuffer(AudioManager.buffers.monster, { gain: clamp(1.4 - dist/18, 0.15, 0.7), rate: 0.9 + App.rng.next()*0.2 });
      }
    }

    // اقتراب الوحش الشديد = فقدان الاسم بالكامل => نهاية مأساوية
    if(this.state !== 'illusion' && dist < 1.6){
      GameFlow.gameOver(false);
    }
  }
};

/* =========================================================
   Collectibles and HUD
   ========================================================= */
const Gameplay = {
  collected: new Set(),
  required: 5,
  messageTimer: 0,
  inventory: [],

  // مزامنة ظهور/اختفاء الأدلة بعد التحميل من الحفظ
  applyCollectedVisibility(){
    for(const orb of Forest.clueItems){
      const idx = orb.userData.index;
      orb.visible = !this.collected.has(idx);
    }
  },

  showMessage(text, seconds = 2.0){
    const node = document.getElementById('hud-message');
    node.textContent = text;
    node.classList.add('show');
    this.messageTimer = seconds;
  },

  update(dt){
    if(this.messageTimer > 0){
      this.messageTimer -= dt;
      if(this.messageTimer <= 0){
        document.getElementById('hud-message').classList.remove('show');
      }
    }

    // Update HUD counter
    const counter = document.getElementById('clue-counter');
    counter.textContent = `أدلة: ${this.collected.size} / ${this.required}`;

    // Collect logic
    const p = Player.getPosition();
    for(const orb of Forest.clueItems){
      if(this.collected.has(orb.userData.index)) continue;
      const dx = p.x - orb.position.x;
      const dz = p.z - orb.position.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      if(dist < 1.6){
        this.collected.add(orb.userData.index);
        orb.visible = false;
        this.inventory.push(`ومضة ${orb.userData.index+1}`);
        UIHud.refreshInventory(this.inventory);
        this.showMessage('ومضة استعادة… جزء من الاسم عاد إليك');
        // Footstep-like cue
        AudioManager.playBuffer(AudioManager.buffers.step, { gain: 1.0 });

        // Story reveal snippets tied to collection count
        const reveals = [
          'الهمس يتهجّى الحرف الأول…',
          'رأيتَ الجذوع تتحرك كأضلاع صدرك…',
          'العين الخضراء لا ترمش…',
          'دائرة الأشجار تُقاس بالسكوت…',
          'اسمك يكتمل… والفم يفتح طريقاً.'
        ];
        Gameplay.showMessage(reveals[Math.min(this.collected.size-1, reveals.length-1)], 3.4);
      }
    }

    // Activate portal when all collected
    if(this.collected.size >= this.required && !Forest.portalActive){
      Forest.setPortalActive(true);
      // اكتمال جمع الأدلة = اكتمال الاسم => انفتاح "فم" الغابة كطريق خروج
      this.showMessage('الفم انفتح… اتجه نحو الضوء للخروج');
    }

    // Enter portal to win
    if(Forest.portalActive){
      const dx = p.x - Forest.portal.position.x;
      const dz = p.z - Forest.portal.position.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      if(dist < 3.2){
        GameFlow.gameOver(true);
      }
    }
  }
};

/* =========================================================
   Virtual Controls (mobile-friendly)
   - Joystick left for movement; right area for look
   ========================================================= */
const Controls = {
  joy: null, stick: null, rect: null,
  origin: {x:0, y:0},
  active: false,
  lookActive: false,
  btnTorch: null,
  btnCrouch: null,
  btnSprint: null,

  init(){
    this.joy = document.getElementById('joystick-left');
    this.stick = this.joy.querySelector('.stick');
    this.rect = this.joy.getBoundingClientRect();

    // Movement joystick
    const onStart = (e)=>{
      this.active = true; const t = this._point(e); this.origin = t; this._updateStick(t);
    };
    const onMove = (e)=>{ if(!this.active) return; const t = this._point(e); this._updateStick(t); };
    const onEnd = ()=>{ this.active = false; this.stick.style.left = '28px'; this.stick.style.top = '28px'; App.input.move.x = 0; App.input.move.y = 0; };
    this.joy.addEventListener('touchstart', onStart, {passive:true});
    this.joy.addEventListener('touchmove', onMove, {passive:true});
    this.joy.addEventListener('touchend', onEnd);
    this.joy.addEventListener('touchcancel', onEnd);

    // Look area
    const look = document.getElementById('look-area');
    const lookStart = ()=>{ App.input.draggingLook = true; this.lookActive = true; };
    const lookMove = (e)=>{ if(!this.lookActive) return; const t = this._point(e); App.input.look.dx += t.dx; App.input.look.dy += t.dy; };
    const lookEnd = ()=>{ this.lookActive = false; };
    look.addEventListener('touchstart', (e)=>{ this._point(e); lookStart(e); }, {passive:true});
    look.addEventListener('touchmove', (e)=>{ const t = this._point(e); lookMove({dx:t.dx, dy:t.dy}); }, {passive:true});
    look.addEventListener('touchend', lookEnd);
    look.addEventListener('touchcancel', lookEnd);

    // Desktop support (mouse)
    look.addEventListener('mousedown', ()=>{ this.lookActive = true; });
    window.addEventListener('mousemove', (e)=>{ if(!this.lookActive) return; App.input.look.dx += e.movementX; App.input.look.dy += e.movementY; });
    window.addEventListener('mouseup', ()=>{ this.lookActive = false; });

    // Torch / Crouch / Sprint buttons
    this.btnTorch = document.getElementById('btn-torch');
    this.btnCrouch = document.getElementById('btn-crouch');
    this.btnSprint = document.getElementById('btn-sprint');
    if(this.btnTorch){
      const toggleTorch = ()=>{ Player.torchOn = !Player.torchOn; this.btnTorch.classList.toggle('active', Player.torchOn); };
      this.btnTorch.addEventListener('click', toggleTorch);
      this.btnTorch.addEventListener('touchstart', (e)=>{ e.preventDefault(); toggleTorch(); }, {passive:false});
    }
    if(this.btnCrouch){
      const toggleCrouch = ()=>{ Player.crouching = !Player.crouching; Player.sprinting = false; this.btnCrouch.classList.toggle('active', Player.crouching); };
      this.btnCrouch.addEventListener('click', toggleCrouch);
      this.btnCrouch.addEventListener('touchstart', (e)=>{ e.preventDefault(); toggleCrouch(); }, {passive:false});
    }
    if(this.btnSprint){
      const startSprint = ()=>{ if(Player.stamina > 0.2 && !Player.crouching) Player.sprinting = true; };
      const stopSprint  = ()=>{ Player.sprinting = false; };
      this.btnSprint.addEventListener('mousedown', startSprint);
      this.btnSprint.addEventListener('mouseup', stopSprint);
      this.btnSprint.addEventListener('mouseleave', stopSprint);
      this.btnSprint.addEventListener('touchstart', (e)=>{ e.preventDefault(); startSprint(); }, {passive:false});
      this.btnSprint.addEventListener('touchend', (e)=>{ e.preventDefault(); stopSprint(); }, {passive:false});
      this.btnSprint.addEventListener('touchcancel', (e)=>{ e.preventDefault(); stopSprint(); }, {passive:false});
    }
  },

  _point(e){
    const touch = e.touches ? e.touches[0] : e;
    const x = touch.clientX, y = touch.clientY;
    if(e.touches && e.touches.length === 1){ this._last = {x,y}; } else if(this._last){ /* keep last */ }
    const dx = this._last ? (x - this._last.x) : 0; const dy = this._last ? (y - this._last.y) : 0; this._last = {x,y};
    return { x, y, dx, dy };
  },

  _updateStick(pt){
    const r = this.joy.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const dx = pt.x - cx, dy = pt.y - cy;
    const len = Math.sqrt(dx*dx + dy*dy);
    const max = r.width/2 - 8;
    const nx = len > 0 ? dx / len : 0;
    const ny = len > 0 ? dy / len : 0;
    const clamped = Math.min(len, max);
    const sx = 28 + nx * clamped; const sy = 28 + ny * clamped;
    this.stick.style.left = `${sx}px`; this.stick.style.top = `${sy}px`;
    App.input.move.x = clamp(dx / max, -1, 1);
    App.input.move.y = clamp(-dy / max, -1, 1);
  }
};

/* =========================================================
   Save/Load
   ========================================================= */
const SaveSystem = {
  save(){
    const data = {
      collected: Array.from(Gameplay.collected),
      player: { x: Player.holder.position.x, z: Player.holder.position.z, yaw: Player.yaw, pitch: Player.pitch, stamina: Player.stamina, sanity: Player.sanity, torchOn: Player.torchOn },
      portalActive: Forest.portalActive,
      rngSeed: 1337 // static for deterministic layout across sessions
    };
    localStorage.setItem(App.saveKey, JSON.stringify(data));
    Gameplay.showMessage('تم الحفظ محلياً');
  },
  load(){
    const raw = localStorage.getItem(App.saveKey);
    if(!raw) return false;
    try{
      const data = JSON.parse(raw);
      Gameplay.collected = new Set(data.collected || []);
      Player.holder.position.x = data.player?.x || 0;
      Player.holder.position.z = data.player?.z || 0;
      Player.yaw = data.player?.yaw || 0;
      Player.pitch = data.player?.pitch || 0;
      Player.stamina = data.player?.stamina ?? 1.0;
      Player.sanity = data.player?.sanity ?? 1.0;
      Player.torchOn = !!data.player?.torchOn;
      Forest.setPortalActive(!!data.portalActive);
      return true;
    }catch(e){ console.warn('Failed to load save', e); return false; }
  },
  delete(){ localStorage.removeItem(App.saveKey); }
};

/* =========================================================
   Game Flow and UI wiring
   ========================================================= */
const GameFlow = {
  start(){
    this.cacheUI();
    this.bindUI();
    this.initThree();
    this.resize();
    window.addEventListener('resize', ()=> this.resize());
    this.animate();
  },

  cacheUI(){
    App.ui.menu = document.getElementById('main-menu');
    App.ui.btnStart = document.getElementById('btn-start');
    App.ui.btnLoad = document.getElementById('btn-load');
    App.ui.btnDelete = document.getElementById('btn-delete');
    App.ui.hud = document.getElementById('hud');
    App.ui.gameOver = document.getElementById('game-over');
    App.ui.gameOverText = document.getElementById('game-over-text');
    App.ui.btnRestart = document.getElementById('btn-restart');
    App.ui.btnMenu = document.getElementById('btn-menu');
    App.ui.btnMenuFromEnd = document.getElementById('btn-menu-from-end');
    App.ui.btnMute = document.getElementById('btn-mute');
  },

  bindUI(){
    App.ui.btnStart.addEventListener('click', async ()=>{
      App.state = 'intro';
      App.ui.menu.classList.remove('visible');
      document.getElementById('hud').classList.add('visible');
      await StoryManager.runIntro();
    });
    App.ui.btnLoad.addEventListener('click', ()=>{
      App.ui.menu.classList.remove('visible');
      document.getElementById('hud').classList.add('visible');
      this.setupScene();
      AudioManager.ensureAmbient();
      const ok = SaveSystem.load();
      if(!ok){ Gameplay.showMessage('لا يوجد حفظ محلي'); }
      Gameplay.applyCollectedVisibility();
      App.state = 'playing';
    });
    App.ui.btnDelete.addEventListener('click', ()=>{ SaveSystem.delete(); alert('تم حذف الحفظ المحلي'); });
    App.ui.btnRestart.addEventListener('click', ()=>{ this.resetToMenu(); });
    App.ui.btnMenu.addEventListener('click', ()=>{ this.resetToMenu(); });
    App.ui.btnMenuFromEnd.addEventListener('click', ()=>{ this.resetToMenu(); });
    App.ui.btnMute.addEventListener('click', ()=>{ const muted = AudioManager.muteToggle(); App.ui.btnMute.textContent = muted ? '🔇' : '🔊'; });

    // Pause/settings
    const pauseOverlay = document.getElementById('pause-overlay');
    const btnPause = document.getElementById('btn-pause');
    const btnResume = document.getElementById('btn-resume');
    const btnSaveNow = document.getElementById('btn-save-now');
    const qualitySelect = document.getElementById('quality-select');
    const lookRange = document.getElementById('look-sensitivity');
    const volRange = document.getElementById('master-volume');
    const togglePause = ()=>{
      if(App.state === 'playing'){
        App.state = 'paused'; pauseOverlay.classList.add('visible');
      }else if(App.state === 'paused'){
        App.state = 'playing'; pauseOverlay.classList.remove('visible');
      }
    };
    btnPause.addEventListener('click', togglePause);
    btnResume.addEventListener('click', togglePause);
    btnSaveNow.addEventListener('click', ()=> SaveSystem.save());
    qualitySelect.addEventListener('change', (e)=>{ App.settings.quality = e.target.value; PerfScaler.applyQuality(App.settings.quality); });
    lookRange.addEventListener('input', (e)=>{ App.settings.sensitivity = parseFloat(e.target.value); });
    volRange.addEventListener('input', (e)=>{ const v = parseFloat(e.target.value); App.settings.masterVolume = v; if(AudioManager.masterGain) AudioManager.masterGain.gain.value = AudioManager.isMuted ? 0 : v; });

    // Autosave every 30 seconds during play
    setInterval(()=>{ if(App.state === 'playing') SaveSystem.save(); }, 30000);
  },

  initThree(){
    App.canvas = document.getElementById('game-canvas');
    App.renderer = new THREE.WebGLRenderer({ canvas: App.canvas, antialias: false, powerPreference: 'high-performance' });
    App.renderer.setPixelRatio(App.dpr);
    App.renderer.setSize(window.innerWidth, window.innerHeight, false);
    App.renderer.outputColorSpace = THREE.SRGBColorSpace;
    App.renderer.shadowMap.enabled = false; // perf
    App.scene = new THREE.Scene();
    App.camera = new THREE.PerspectiveCamera(65, window.innerWidth/window.innerHeight, 0.1, 600);
    App.scene.background = new THREE.Color(0x050709);

    // UI systems
    Controls.init();
    StoryManager.init();
    UIHud.init();
    PerfScaler.applyQuality(App.settings.quality);
  },

  setupScene(){
    // Reset RNG for deterministic placements
    App.rng.setSeed(1337);
    // Build forest
    Forest.init();
    // Player and monster
    Player.init();
    Monster.init();
    // ابدأ صوت الغابة فور الدخول للّعب
    AudioManager.ensureAmbient();
  },

  startGameplay(){
    this.setupScene();
    App.state = 'playing';
  },

  gameOver(survived){
    App.state = 'gameover';
    App.ui.gameOver.classList.add('visible');
    App.ui.gameOverText.textContent = survived ? 'خرجت من الفم… اسمك عاد إليك.' : 'الهمس ابتلع اسمك. صرتَ صدى.';
    // Delay, then show ending narrative tied to survival
    setTimeout(()=>{
      App.ui.gameOver.classList.remove('visible');
      App.state = 'ending';
      StoryManager.showEnding(survived);
    }, 2200);
  },

  resetToMenu(){
    // Hard reload for simplicity (cleans WebGL)
    window.location.reload();
  },

  resize(){
    const w = window.innerWidth, h = window.innerHeight;
    App.renderer.setSize(w, h, false);
    App.camera.aspect = w/h; App.camera.updateProjectionMatrix();
  },

  animate(){
    requestAnimationFrame(()=> this.animate());
    const dt = Math.min(0.033, App.clock.getDelta());
    const t = App.clock.elapsedTime;

    if(App.state === 'playing'){
      Player.update(dt);
      Monster.update(dt, t);
      Forest.update(dt, t);
      Gameplay.update(dt);
      UIHud.updateFX(Player.stamina, Player.sanity);

      // Footsteps
      if((Math.abs(App.input.move.x) + Math.abs(App.input.move.y)) > 0.15){
        AudioManager.footstepCooldown -= dt;
        if(AudioManager.footstepCooldown <= 0){
          AudioManager.footstepCooldown = 0.42;
          AudioManager.playBuffer(AudioManager.buffers.step, { gain: 0.7 + App.rng.next()*0.3, rate: 0.9 + App.rng.next()*0.2 });
        }
      }

      // Reactive audio: breath and whispers
      if(AudioManager.context){
        AudioManager.breathTimer -= dt;
        AudioManager.whisperTimer -= dt;
        if(AudioManager.breathTimer <= 0 && Player.stamina < 0.35){
          AudioManager.breathTimer = 2.0 - Player.stamina * 1.2;
          AudioManager.playBuffer(AudioManager.buffers.breath, { gain: 0.25 + (1-Player.stamina)*0.35, rate: 1.0 });
        }
        const prox = Monster.proximity || 999;
        const sanityLow = 1 - Player.sanity;
        if(AudioManager.whisperTimer <= 0 && (prox < 16 || sanityLow > 0.3)){
          AudioManager.whisperTimer = 3.5 - Math.min(2.5, sanityLow*3 + (16-prox)*0.08);
          AudioManager.playBuffer(AudioManager.buffers.whisper, { gain: clamp(0.15 + sanityLow*0.4 + (16-prox)*0.02, 0.1, 0.6), rate: 0.9 + App.rng.next()*0.2 });
        }
      }
    }

    App.renderer.render(App.scene, App.camera);
  }
};

/* =========================================================
   UI: Main Menu Buttons
   ========================================================= */
function wireMainMenu(){
  const btnStart = document.getElementById('btn-start');
  const btnLoad = document.getElementById('btn-load');
  const btnDelete = document.getElementById('btn-delete');
  btnStart.disabled = false; btnLoad.disabled = false; btnDelete.disabled = false;
}

/* =========================================================
   Game bootstrap
   ========================================================= */
window.addEventListener('load', ()=>{
  wireMainMenu();
  GameFlow.start();
});

/* =========================================================
   UI HUD and FX helpers
   ========================================================= */
const UIHud = {
  staminaBar: null,
  sanityBar: null,
  fxSanity: null,
  inventoryList: null,
  init(){
    this.staminaBar = document.querySelector('#bar-stamina .bar-inner');
    this.sanityBar = document.querySelector('#bar-sanity .bar-inner');
    this.fxSanity = document.getElementById('fx-sanity');
    this.inventoryList = document.getElementById('inventory-list');
  },
  updateBars(stamina, sanity){
    if(this.staminaBar) this.staminaBar.style.width = `${Math.round(stamina*100)}%`;
    if(this.sanityBar) this.sanityBar.style.width = `${Math.round(sanity*100)}%`;
  },
  updateFX(stamina, sanity){
    if(this.fxSanity){ this.fxSanity.style.opacity = `${clamp(1 - sanity, 0, 0.35)}`; }
  },
  refreshInventory(items){
    if(!this.inventoryList) return;
    this.inventoryList.innerHTML = '';
    for(const it of items){
      const li = document.createElement('li'); li.textContent = it; this.inventoryList.appendChild(li);
    }
  }
};

/* =========================================================
   Performance Scaler
   ========================================================= */
const PerfScaler = {
  applyQuality(level){
    // Adjust pixel ratio and forest density
    const base = Math.min(window.devicePixelRatio || 1, 1.5);
    if(level === 'low'){
      App.renderer.setPixelRatio(0.75);
      Forest.treeCount = 320; Forest.rockCount = 80;
    } else if(level === 'high'){
      App.renderer.setPixelRatio(base);
      Forest.treeCount = 520; Forest.rockCount = 150;
    } else {
      App.renderer.setPixelRatio(1.0);
      Forest.treeCount = 450; Forest.rockCount = 120;
    }
  }
};

