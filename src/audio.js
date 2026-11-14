const sounds = {};

export function loadSound(name, { loop = false, volume = 1 } = {}) {
  const audio = new Audio(`${import.meta.env.BASE_URL}audio/${name}.mp3`);
  audio.loop = loop;
  audio.volume = volume;
  audio.preload = 'auto';
  const s = { audio, ok: true };
  audio.addEventListener('error', () => { s.ok = false; });
  sounds[name] = s;
}

export function play(name) {
  const s = sounds[name];
  if (!s || !s.ok) return;
  if (!s.audio.loop) s.audio.currentTime = 0;
  s.audio.play().catch(() => {});
}
