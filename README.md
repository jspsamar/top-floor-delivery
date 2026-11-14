# Top Floor Delivery

The elevator is broken. Climb the outside of the apartment building with a floppy ragdoll and deliver the pizza to the penthouse — without dropping it.

Built with Three.js (orthographic, side-on rendering), Matter.js (2D physics) and Vite.

## Controls

- **Mouse** – your hands reach toward the cursor
- **Hold left click** – left hand grabs a hold it's touching (release to let go)
- **Hold right click** – right hand grabs
- **R** – restart

Keep the pizza box on your head. Reach the penthouse door on the roof (60 m) as fast as you can for a 5-star rating.

## Develop

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # outputs dist/
```

## Assets

- `public/assets/` – 3D models (future milestones)
- `public/audio/` – optional `grab.mp3`, `fall.mp3`, `ruined.mp3`, `music.mp3` (missing files are ignored)

## Deploy

Pushing to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`
(repo Settings → Pages → Source: GitHub Actions).
