# GameShare

A small desktop app for groups of 2 to 10 friends: voice chat plus screen sharing, so everyone can watch each other's games while you talk. Anyone in the room can share at the same time.

It's peer-to-peer. Audio and video go straight from PC to PC; a free public "matchmaking" server (PeerJS) is only used to introduce you to each other. There is no account and nothing to host.

## Run it (for development)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

## Build an installer to send your friends

Build on the same kind of computer your friends use (build the Windows version on Windows, the Mac version on a Mac):

```bash
npm run dist
```

The installer appears in the `dist/` folder:

- **Windows:** `GameShare Setup <version>.exe` (installer) and `GameShare <version>.exe` (portable, no install). Windows SmartScreen will warn because the app isn't code-signed. Click **More info → Run anyway**.
- **Mac:** `GameShare-<version>.dmg`. Because it isn't signed, right-click the app → **Open** the first time. Then allow it under **System Settings → Privacy & Security → Screen Recording** (and Microphone) and reopen it.
- **Linux:** `GameShare-<version>.AppImage` (make it executable, then run it).

## How to use it

1. Type your name, pick the **room size** (click the square for the number of players you want, 2 to 10) and click **Create a room**. Click **Copy invite** in the side panel and paste the message to your friends. Not sure your mic works? Click **Test your microphone** on the start screen first: pick the mic and watch the bar move.
2. Everyone else types (or pastes the whole invite message into) the code box and clicks **Join**. The invite also carries a `gameshare://join/CODE` link: opening it starts GameShare straight in that room. While it's connecting, **Join** turns into **Cancel**. If the room is full they're told so; the host can make it bigger in **Settings → Room size**.
3. Each player gets their own **colour**, the same on everyone's screen: it marks their name, avatar, slot and the banner on their shared screen, and your own buttons use yours. The squares under the room code show the room's slots: filled for each player, empty for free places.
4. Click **Share screen**, pick your game window (or a whole screen), choose **Game** or **Video** (see [Watching videos together](#watching-videos-together)), and click **Share** (or press Enter). The picker remembers what you shared and the mode you used last time.
5. While nobody is sharing, the stage shows everyone's avatar, lighting up as they talk. Shared screens fill the space at their real shape; your own preview tucks in beside your friends' screens. Click any screen to make it big, with the rest in a strip at the side. **Full screen** (the corner button, or a double-click) fills your monitor; controls and the mouse pointer hide after a moment, so just move the mouse to get them back. Press Esc to leave full screen.
6. Hover a share and click **✕** to close it. Your friend stops sending it to you, which saves bandwidth on both ends. Reopen it with **Watch screen** under their name. Closing your own preview hides it without stopping your share.
7. **Click a player** in the side panel for their options: voice volume, *Mute their voice for me*, open or close their screen, and your connection to them (ping and packet loss; the bars next to their name show it at a glance). The speaker that appears when you hover a player mutes their voice in one click.
8. **Volume, for you only** (nobody else is affected):
   - **Voices:** per player as above. **Voices** at the bottom of the panel (or Ctrl+Shift+D) mutes everyone's voice; others see "Can't hear voices" under your name.
   - **Stream sound:** hover a shared screen for its own speaker button and volume slider (they also show for a few seconds when a share starts). Muting voices never mutes streams, and the other way round. If it says **No sound**, the sharer didn't tick the sound box.
   - Under each share's controls you can see **what sound it carries**, for example *sound: chrome.exe only* or *sound: whole computer except GameShare*.
9. The panel button at the top (or Ctrl+Shift+P) folds the side panel into a slim strip of avatars and buttons, so screens get almost the whole window.
10. Friends running an older GameShare get an **Old version** tag. Everyone should be on the same version (rooms bigger than 4 need everyone on 1.4 or newer; reconnecting by itself needs 1.5; the Video mode extras need 1.7).
11. **Leaving and coming back:** **Leave** takes you out at once and shows **Undo** for a few seconds to go straight back (while you're sharing your screen it asks for a second click first, so a slip doesn't end your stream). the room stays open as long as anyone is in it, even if its creator leaves (whoever keeps it open becomes the host, marked with a crown, and can change the room size). The start screen shows **Rejoin room ABC123** for 12 hours; if everyone had left, Rejoin opens the room again under the same code and size.
12. **Dropped connections fix themselves.** If someone's internet hiccups, their Wi-Fi reconnects or their laptop switches networks, they stay in the room marked **Reconnecting…** (a frozen screen says so too) and come back on their own, voice and screens included, usually within a few seconds of their connection returning. Only if they’re gone for about 50 seconds are they taken out of the room, and even then they find their way back by themselves once their internet returns. Leaving with the button or closing the app tells everyone right away.
13. **If GameShare crashes**, it reopens and puts you straight back in the room as the same player (same colour, still muted if you were). Friends just see you reconnect.
14. **In-game overlay** (Settings → App): shows who's talking in a corner of your screen while you play, plus a reminder when you're muted. It works over borderless and windowed games (not exclusive full screen), never takes clicks, and hides while GameShare itself is in front.
15. **Soundboard** (the **Sounds** button at the bottom of the panel): click **Add sounds…** and pick audio files (MP3, WAV, OGG and the like, up to 60 seconds and 10 MB each, 30 sounds at most). They are saved on your computer, inside GameShare's own storage, so they're still there next time; nothing is uploaded anywhere. Click a sound and everyone in the room hears it in your voice, and so do you. It plays even while you're muted. Click it again to stop it, use the slider for its volume, and hover a sound and click **✕** to remove it. Friends on any version hear it; a friend who muted your voice doesn't.

**Settings** (bottom of the panel) has four pages and reopens on the one you used last:
- **Voice:** your microphone (with a level meter: talk to test it), your speakers or headset, *Remove background noise*, *Headphones mode* and *Lower streams while friends talk*.
- **Sharing:** share quality, **Bitrate** and the room size (host only). (Game or Video mode is picked in the share picker.)
- **Shortcuts:** change the keys for mute, mute voices, collapsing the panel and cinema mode (click one, press the new keys), whether they work while a game has focus, and **Push-to-talk**.
- **App:** language, the in-game overlay and its corner, sound effects, *Keep running when I close the window*, updates, and **Copy report** for troubleshooting.

**Language:** GameShare speaks English and Brazilian Portuguese (português do Brasil). It follows your computer's language; to change it, use the menu at the bottom of the start screen or **Settings → App → Language**. It switches right away, even in a room. Each player picks their own, so friends can use different languages in the same room, and invites copied in either language work for everyone. (The **Copy report** text stays in English.) To add a language, see the top of `i18n.js`.

**Tips**

- Mute/unmute: **Ctrl+Shift+M**. Mute voices: **Ctrl+Shift+D**. While you're in a room both work even when your game has focus. If they clash with a game or another app, change them in **Settings → Shortcuts** (or turn off *Shortcuts work in games*). Inside GameShare, **Ctrl+Shift+P** folds the panel and **Ctrl+Shift+C** is cinema mode.
- **Push-to-talk** (Settings → Shortcuts): your mic is only live while you hold the key you pick (a key, or a side mouse button). On Windows it works while a game has focus and the game still gets the key; on Mac and Linux it works while GameShare is in front. The Mute button still mutes you outright.
- **Talking while muted?** The mic button pulses and a note reminds you (not in push-to-talk).
- **Keep running when I close the window** (Settings → App, off by default): while you're in a room, closing the window hides GameShare next to the clock instead of leaving the call. Click its icon to bring it back, or right-click → *Leave and quit*.
- Notes at the top stay longer the more there is to read, and errors stay until you close them (click the note).
- **Remove background noise** (on by default) filters keyboard clicks, fans and game sound picked up by your microphone, using RNNoise, a small noise filter built for voices that runs on your PC. It adds 10 ms of delay. If your voice ever sounds watery, turn it off.
- If friends can't hear you, check **Settings → Microphone**: talk and watch the meter. GameShare remembers the microphone and speakers you pick; if one is unplugged it switches to the system default and tells you.
- **Wearing headphones? Turn on _Headphones mode_ in Settings.** It switches off echo cancellation, which otherwise clips your voice whenever other sound is playing and is the most common cause of choppy-sounding voice. Leave it off if you use speakers, or friends will hear themselves echo.
- Voice is sent with a backup copy of each packet and gets priority over screen video, so it holds up on a busy or slightly lossy connection. If the person sharing sounds choppy, their PC or upload is overloaded: they can set Share quality to `720p, 30 fps` in Settings.
- **Smooth streaming:** shared screens keep their frame rate when the sharer's PC or connection is busy (the picture gets a little softer instead of stuttering). Each viewer plays friends' screens about 0.2 s behind live so late packets still arrive in time, and if freezes still happen that cushion grows by itself (up to 0.6 s) and shrinks back once things are calm. Voice is never delayed.
- **A shared screen that gets stuck small fixes itself.** After a moment of congestion or a busy PC, WebRTC sometimes shrinks a share (to 180p, say) and never grows it back, even once the connection is fine; closing and reopening the screen used to be the only fix. Now the sharer's app notices within about 20 seconds when a friend gets far less than they asked for on a healthy connection, and first nudges its encoder back up, with no interruption. If it shrinks again, it reopens the share for that friend (a second or two of *Reconnecting…*). It leaves things alone when the connection really is congested or the picture is simply too busy for the bitrate, and stops trying for 10 minutes if a fix doesn't hold. Works in both Game and Video mode; it needs the **sharer** on this version. What it did shows up under *Recent events* in **Copy report**.
- **Bitrate** (Settings → Sharing) is the most each friend can get from your screen. *Automatic* uses the quality's own (shown next to it; 1.5× in Video mode); pick 3 to 20 Mbps to override it, for example a higher one if fast games look blocky or drop frames and your upload can take it, or a lower one if friends stutter. It changes right away, even mid-share, and the total for everyone watching is still capped at twice that.
- **Share quality** (Settings) affects your own share. Everyone watching you together gets at most about twice the quality's bitrate (about 9 Mbps at 1080p 30 fps, 16 Mbps at 60 fps), split between them, so a big room can't flood your upload. Drop to 720p if your upload is slow.
- **Sharing sound (Windows 10 version 2004 or newer, and Windows 11):** tick the sound box in the share picker.
  - Sharing a **window** sends only that app's sound (the game, or the browser tab's video). Your call, Discord, music and everything else stay out.
  - Sharing a **whole screen** sends all computer sound *except* GameShare, so friends never hear their own voices back.
  - If sound can't be captured (older Windows), the share still works with picture only and the app tells you why.
  - Store/UWP apps run inside a host process and may share no sound; use a whole-screen share for those.
  - Windows treats a whole program as one app. If Discord (or music) is open **in the same browser** you're sharing, its sound comes along. Use the Discord desktop app, or a different browser for it.
- If a full-screen game shows up black, switch the game to *Borderless windowed* mode, or share the whole screen instead of the window.
- Each friend is sent your screen at the size they're actually watching it (smaller in a grid, full resolution in full screen), and nothing at all while they have GameShare minimized. That keeps your upload and your PC's load down while you play.

## Watching videos together

GameShare started out for games, where the less delay the better. A film, a YouTube video or a player like VLC wants the opposite: a steady picture and good sound, and nobody minds if it arrives a second late. So the share picker has two modes, and the person sharing chooses:

- **Game** (the default): the lowest delay. Exactly how sharing always worked.
- **Video:** for anything you watch rather than play. If the window you pick looks like a browser or a video player, the picker suggests it, but it never switches by itself, and it remembers your choice for next time.

What Video mode changes:

- **Smooth before fast.** Friends play your screen about 1 s behind live instead of 0.2 s, so a hiccup in someone's connection passes without the picture freezing. If it still freezes, that cushion grows by itself (up to 3 s) and shrinks back when things calm down. Voices are never delayed, so when the sharer laughs you hear it a moment before you see the scene.
- **A better picture.** Your PC sends it with 1.5× the bitrate, at the frame rate of your *Share quality* (pick `1080p, 60 fps` for 60 fps videos). When the connection or the PC struggles, the frame rate is kept and the picture softens a little. When you **pause**, it's the other way round: the picture is kept sharp, so subtitles and small text stay readable.
- **Better sound.** The stream's sound goes out in stereo at 192 kbps (128 kbps in Game mode), with none of the voice clean-up your microphone gets (no echo cancellation, no automatic volume, no noise removal, no cutting of quiet parts), so music and soundtracks don't sound muffled.
- **Lip sync.** The sound of the shared app used to reach friends a little after the picture. It's now kept much closer in both modes, and in Video mode each viewer also plays the sound a touch sooner to make up for what's left.

For the people watching:

- **Cinema mode** (**Ctrl+Shift+C**, or the **Cinema** button on a friend's screen): that screen fills the GameShare window and everything else hides, including the controls and the mouse pointer after a moment. It also asks the sharer for the full picture, so subtitles are as sharp as they can be. Press **Esc** to leave. *Full screen* still works on top of it.
- **Lower streams while friends talk** (Settings → Voice, off by default): while a friend is talking, the sound of shared screens drops to a share of its volume (40% unless you move the slider) and comes back when they stop. Only you hear the difference.

**A black picture from Netflix, Prime Video, Disney+ and the like.** Streaming sites protect their video, and a screen capture of it comes out black while the sound plays. When GameShare sees that on a browser window you're sharing, it tells you once. What usually brings the picture back is turning off *Use graphics acceleration when available* (hardware acceleration) in that browser's settings and restarting the browser. GameShare doesn't try to get around the protection: if the site still shows black, it can't be shared.

**Friends on an older GameShare** can still watch a Video share. On 1.6 they get the steadier picture (their old 1.5 s cushion), the higher bitrate and the better sound; the lip-sync correction, cinema mode and lowering streams while friends talk need 1.7 on their side. They show the **Old version** tag as usual.

**Checking it:** **Stats** on a friend's screen shows the mode, the buffer it has and the one it aims for, the stream sound's bitrate, and how far the sound is from the picture (*sound in sync*, or *sound 20 ms late*). On your own preview it shows the mode, the frame rate being captured, and how long the app's sound waits before it's sent. **Copy report** has the same numbers.

## Updates

GameShare can update itself, but only if you want it to. When it opens it looks for a newer version (a small request to GitHub). If there is one, the start screen offers **Update**, **Not now** or **Skip this version**. Nothing downloads until you click Update. The download is a few MB because it carries only GameShare's own code, not Electron. The new version starts the next time you open GameShare, or right away with **Restart now** (never in the middle of a call).

In **Settings → App** you can turn off *Check for updates*, check by hand, or go **Back to** the version your installer came with.

Updates are signed: GameShare only runs one signed with the maintainer's key. If an updated version fails to start twice in a row, GameShare goes back to the installed version by itself. Updates that need a newer Electron (or a new installer) show a **Download** button that opens the releases page instead.

### Publishing an update (maintainer)

One time:

1. `npm run update:keygen`. This creates your signing key at `~/.gameshare/update-key.pem` and writes its public half into `boot.js`. **Back up the key and never commit it.** Whoever has it can push code to everyone's GameShare. If you lose it, friends need a new installer to keep getting updates.
2. Build and hand out an installer with that key (`npm run dist`). Only installs from then on can update themselves.

Each release:

1. Bump `version` in `package.json` and commit.
2. `npm run update:pack -- --notes "One or two lines about what's new"` makes `dist/update/gameshare-app-<version>.asar` and `dist/update/update.json`.
3. On GitHub, create a release for that version and attach both files (plus the installers, if you built them). Mark it as the **latest** release. The app reads `releases/latest/download/update.json`, so the repository (or at least its releases) must be public.

An in-app update can't change Electron, `boot.js` or the native audio helper (`bin/`). When you upgrade Electron's major version or change those, ship a new installer. Older installs then see *needs a fresh install* with a Download button.

## If friends can't connect

Most home networks work out of the box. Very strict networks (some schools, offices, mobile hotspots) can block direct connections; PeerJS's free relay servers are tried automatically, but they're best-effort. If a friend can never connect, try a different network.

**Looking into a problem:**
- **Stats** (button on any shared screen, shown on hover): resolution, frame rate, bitrate, codec, whether your graphics card is doing the decoding, delay, freezes, packet loss, the sharing mode, the stream's sound and its lip sync, and whether the connection is direct or relayed. On your own preview it shows what each friend is getting from you and whether your PC or your connection is holding it back.
- **Settings → Copy report** copies a plain-text report (versions, graphics, devices, settings, every friend's connection and stream numbers, recent connection events) to paste to whoever is helping. It has no IP addresses.

## Optional: your own matchmaking server

If the free PeerJS server is ever down, run your own (`npx -p peer peerjs --port 9000 --path /gameshare` on any machine everyone can reach, for example one PC on your network or a small cloud server) and start the app on every PC with:

```bash
GAMESHARE_SIGNAL=http://your-server:9000/gameshare npm start
```

## Optional: clickable invite links

Chat apps don't turn `gameshare://` links into something you can click. To get a normal web link in your invites, publish `docs/join.html` (for example with GitHub Pages: repository **Settings → Pages → Deploy from a branch → `/docs`**) and put its address in `INVITE_PAGE` at the top of `renderer.js`, for example `https://your-name.github.io/GAMESHARE/join.html`. Invites then read `…/join.html#ABC123`: the page shows the code, a button that opens GameShare in that room, and a download link.

## Files

| File | What it does |
| --- | --- |
| `main.js` | Window, permissions and the screen/window capture hookup |
| `preload.js` | The small bridge the page uses to list windows |
| `renderer.js` | Rooms, voice, screen sharing (PeerJS / WebRTC mesh) |
| `index.html`, `styles.css` | The interface |
| `fonts/` | Archivo, the interface font (SIL Open Font License, see `fonts/OFL.txt`) |
| `native/app-audio.cpp` | Source of `bin/win32-x64/GameShareAudio.exe`, the small helper that records one app's sound (Windows process-loopback API). Rebuild with `npm run build:audio` (needs the MinGW cross-compiler) |
| `app-audio-worklet.js` | Turns the helper's raw sound into an audio track for the share, keeping as little of it waiting as possible (for lip sync) |
| `noise-worklet.js`, `vendor/rnnoise-sync.js` | Background-noise removal for your microphone (RNNoise compiled to WebAssembly, from `@jitsi/rnnoise-wasm`; license in `vendor/rnnoise-LICENSE.txt`) |
| `overlay.html`, `overlay.js`, `overlay-preload.js` | The in-game overlay window |
| `native/keys.cpp` | Source of `bin/win32-x64/GameShareKeys.exe`, the small helper that tells GameShare when the push-to-talk key is held while a game has focus (Windows). Rebuild with `npm run build:keys` |
| `docs/join.html` | Optional web page for invite links (see below) |
