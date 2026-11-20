# YouTube links on a tablet (the Reel Maker helper)

Reel Maker runs entirely in the browser, and browsers can't download videos from YouTube. The
helper, `server.py`, fills that gap: it runs on your tablet (or any computer), downloads links with
[yt-dlp](https://github.com/yt-dlp/yt-dlp), and opens Reel Maker with a **Paste a YouTube link** box.

Only use videos you have permission to use.

## One-time setup (Samsung Tab or any Android)

1. Install **Termux** from F-Droid: <https://f-droid.org/packages/com.termux/>. Don't use the Play
   Store version, which is out of date.
2. Open Termux and run these commands one at a time. Answer `y` if asked:

   ```bash
   pkg update && pkg upgrade -y
   ```

   ```bash
   pkg install -y python ffmpeg
   ```

   ```bash
   pip install -U yt-dlp
   ```

   ```bash
   curl -O https://reel-editor-omega.vercel.app/server.py
   ```

3. So Android doesn't stop it in the background: **Settings → Apps → Termux → Battery →
   Unrestricted**.

## Every time

1. Open Termux and start the helper:

   ```bash
   python server.py
   ```

2. In Chrome on the tablet, open **http://localhost:8765**.
3. In step 1 (Video), paste a YouTube link and tap **Get video**. The video loads as if you'd
   picked a file; everything else works as usual.

To stop the helper, press **Ctrl+C** in Termux (on Termux's extra keys row: CTRL, then C).

## Good to know

- **Format:** the helper asks YouTube for H.264 video, which the app can read. If YouTube only offers
  AV1 (which the app can't read), the helper converts it on the tablet first; that takes a few minutes.
- **Quality:** downloads are 720p by default, which is easier on memory when the app builds the
  reel. For 1080p: `python server.py --quality 1080`.
- **Length limit:** videos up to 60 minutes. Change it with `--max-minutes 120`.
- **If downloads start failing:** YouTube changes often, and yt-dlp is updated to keep up. Run
  `pip install -U yt-dlp` and start the helper again.
- **Using it from your phone too:** start it with `python server.py --lan`, and it prints an address
  like `http://192.168.1.20:8765` to open on your phone (same Wi-Fi). Anyone on that Wi-Fi could use
  it while it runs. On that address the app uses the standard (single-threaded) video engine.
- **Updating the helper:** run the `curl -O …/server.py` command again.
- **Disk space:** downloaded videos are kept in `~/reelmaker-downloads` for two hours, then deleted.
- **Privacy:** the helper only listens on the tablet itself (unless you use `--lan`). It loads the
  app's pages from the Reel Maker website, and the download goes straight from YouTube to the
  tablet.
