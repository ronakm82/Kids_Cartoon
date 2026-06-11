var express = require("express");
var fetch = require("node-fetch");
var ffmpeg = require("fluent-ffmpeg");
var ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
var fs = require("fs");
var path = require("path");

ffmpeg.setFfmpegPath(ffmpegPath);

var app = express();
app.use(express.json({ limit: "50mb" }));

var OUTPUT_DIR = path.join(__dirname, "outputs");
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Cartoon-themed Pixabay search terms — cycles through these
var CARTOON_THEMES = [
  "cartoon animation",
  "kids animation colorful",
  "cartoon space rocket",
  "animated adventure kids",
  "cartoon animals funny",
  "colorful cartoon background",
  "kids cartoon characters",
  "animated stars space"
];

// Fetch a random cartoon video URL from Pixabay
async function getPixabayVideoUrl(theme) {
  var apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) {
    console.log("No PIXABAY_API_KEY set — using fallback video");
    return null;
  }

  var searchTerm = theme || CARTOON_THEMES[Math.floor(Math.random() * CARTOON_THEMES.length)];
  var encoded = encodeURIComponent(searchTerm);
  var url = "https://pixabay.com/api/videos/?key=" + apiKey +
    "&q=" + encoded +
    "&video_type=animation" +
    "&per_page=10" +
    "&safesearch=true";

  console.log("Searching Pixabay for: " + searchTerm);

  try {
    var res = await fetch(url);
    if (!res.ok) {
      console.log("Pixabay API error: " + res.status);
      return null;
    }
    var data = await res.json();
    if (!data.hits || data.hits.length === 0) {
      console.log("No Pixabay results for: " + searchTerm);
      return null;
    }
    // Pick a random result from top 10
    var hit = data.hits[Math.floor(Math.random() * data.hits.length)];
    // Prefer medium quality (960px), fallback to small (640px)
    var videoUrl = (hit.videos.medium && hit.videos.medium.url) ||
                   (hit.videos.small && hit.videos.small.url) ||
                   (hit.videos.tiny && hit.videos.tiny.url);
    console.log("Pixabay video found: " + (videoUrl ? videoUrl.substring(0, 80) : "none"));
    return videoUrl || null;
  } catch (e) {
    console.log("Pixabay fetch error: " + e.message);
    return null;
  }
}

// Smart file getter — handles URL or base64
async function getFile(input, dest) {
  if (!input) throw new Error("Empty input for: " + dest);
  var inputStr = String(input).trim();

  if (inputStr.indexOf("http") !== 0) {
    var base64Data = inputStr
      .replace(/^data:audio\/mp3;base64,/, "")
      .replace(/^data:audio\/mpeg;base64,/, "")
      .replace(/^data:image\/jpeg;base64,/, "")
      .replace(/^data:image\/png;base64,/, "")
      .replace(/^data:video\/mp4;base64,/, "");
    try {
      fs.writeFileSync(dest, Buffer.from(base64Data, "base64"));
      console.log("Wrote base64: " + dest + " " + fs.statSync(dest).size + " bytes");
      return;
    } catch (e) {
      throw new Error("base64 decode failed for " + dest + ": " + e.message);
    }
  }

  console.log("Downloading: " + inputStr.substring(0, 120));
  var res = await fetch(inputStr, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KidsMerger/1.0)" },
    redirect: "follow"
  });
  if (!res.ok) throw new Error("Download failed: " + inputStr.substring(0, 80) + " status: " + res.status);

  return new Promise(function(resolve, reject) {
    var stream = fs.createWriteStream(dest);
    res.body.pipe(stream);
    stream.on("finish", function() {
      console.log("Downloaded: " + dest + " " + fs.statSync(dest).size + " bytes");
      resolve();
    });
    stream.on("error", reject);
  });
}

// Get audio duration in seconds
async function getAudioDuration(audioPath) {
  return new Promise(function(resolve) {
    ffmpeg.ffprobe(audioPath, function(err, metadata) {
      if (err || !metadata || !metadata.format || !metadata.format.duration) {
        console.log("Could not probe audio — defaulting to 120s");
        resolve(120);
      } else {
        var dur = Math.ceil(metadata.format.duration) + 1;
        console.log("Audio duration: " + dur + "s");
        resolve(dur);
      }
    });
  });
}

// Convert static image to looping video (fallback when no Pixabay)
async function imageToVideo(imagePath, outputVideoPath, durationSecs) {
  console.log("Converting image to " + durationSecs + "s video...");
  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1", "-framerate 25"])
      .outputOptions([
        "-c:v libx264",
        "-t " + durationSecs,
        "-pix_fmt yuv420p",
        "-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "-preset fast",
        "-crf 23"
      ])
      .output(outputVideoPath)
      .on("end", function() {
        console.log("Image to video done: " + fs.statSync(outputVideoPath).size + " bytes");
        resolve();
      })
      .on("error", function(err) {
        reject(new Error("imageToVideo failed: " + err.message));
      })
      .run();
  });
}

// Loop a short video clip to fill target duration
async function loopVideoToLength(inputPath, outputPath, durationSecs) {
  console.log("Looping video to " + durationSecs + "s...");
  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(inputPath)
      .inputOptions(["-stream_loop -1"])
      .outputOptions([
        "-c:v libx264",
        "-t " + durationSecs,
        "-pix_fmt yuv420p",
        "-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "-preset fast",
        "-crf 23",
        "-an"
      ])
      .output(outputPath)
      .on("end", function() {
        console.log("Loop done: " + fs.statSync(outputPath).size + " bytes");
        resolve();
      })
      .on("error", function(err) {
        reject(new Error("loopVideo failed: " + err.message));
      })
      .run();
  });
}

function isImageUrl(urlStr) {
  return (
    urlStr.indexOf("picsum.photos") !== -1 ||
    urlStr.indexOf("pollinations.ai") !== -1 ||
    urlStr.indexOf("unsplash.com") !== -1 ||
    urlStr.indexOf(".jpg") !== -1 ||
    urlStr.indexOf(".jpeg") !== -1 ||
    urlStr.indexOf(".png") !== -1 ||
    urlStr.indexOf(".webp") !== -1 ||
    urlStr.indexOf(".gif") !== -1
  );
}

// Health check
app.get("/", function(req, res) {
  res.json({ status: "kids-merger running", version: "6.0" });
});

app.get("/test", function(req, res) {
  res.json({
    version: "6.0",
    pixabay_key: process.env.PIXABAY_API_KEY ? "SET" : "NOT SET",
    railway_url: process.env.RAILWAY_STATIC_URL || "NOT SET",
    port: process.env.PORT || "3000"
  });
});

app.post("/merge", async function(req, res) {
  var videoInput = req.body.video_url;
  var voiceInput = req.body.voice_url;
  var musicInput = req.body.music_url;
  var storyTheme = req.body.theme || "";

  console.log("--- Merge request v6.0 ---");
  console.log("voice_url:", voiceInput ? voiceInput.substring(0, 80) : "MISSING");
  console.log("video_url:", videoInput ? videoInput.substring(0, 80) : "MISSING");
  console.log("theme:", storyTheme || "(none)");

  if (!voiceInput) {
    return res.status(400).json({ error: "Missing voice_url", status: "failed" });
  }

  if (!musicInput) {
    musicInput = "https://files.freemusicarchive.org/storage-freemusicarchive-org/music/WFMU/Broke_For_Free/Directionless_EP/Broke_For_Free_-_01_-_Night_Owl.mp3";
  }

  var jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  var rawClipPath  = path.join(tmpDir, "raw_clip.mp4");
  var imagePath    = path.join(tmpDir, "input_image.jpg");
  var videoPath    = path.join(tmpDir, "video_looped.mp4");
  var voicePath    = path.join(tmpDir, "voice.mp3");
  var musicPath    = path.join(tmpDir, "music.mp3");
  var outputPath   = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");

  try {
    // 1. Download voice — needed first to get duration
    console.log("Step 1 — Downloading voice...");
    await getFile(voiceInput, voicePath);
    if (fs.statSync(voicePath).size < 100) throw new Error("Voice file too small");

    // 2. Get audio duration
    var audioDuration = await getAudioDuration(voicePath);
    if (audioDuration < 5) audioDuration = 120;

    // 3. Get cartoon video from Pixabay (or fallback)
    console.log("Step 2 — Getting cartoon video...");
    var pixabayUrl = await getPixabayVideoUrl(storyTheme);

    if (pixabayUrl) {
      // Download Pixabay cartoon clip and loop it to audio length
      await getFile(pixabayUrl, rawClipPath);
      if (fs.statSync(rawClipPath).size < 1000) throw new Error("Pixabay clip too small");
      await loopVideoToLength(rawClipPath, videoPath, audioDuration);
    } else if (videoInput && !isImageUrl(String(videoInput))) {
      // Direct MP4 video URL provided
      await getFile(videoInput, rawClipPath);
      await loopVideoToLength(rawClipPath, videoPath, audioDuration);
    } else {
      // Fallback — use image (Picsum or provided image URL)
      var imgSrc = videoInput || ("https://picsum.photos/seed/" + jobId + "/1280/720");
      await getFile(imgSrc, imagePath);
      await imageToVideo(imagePath, videoPath, audioDuration);
    }

    if (fs.statSync(videoPath).size < 1000) throw new Error("Video processing failed — file too small");

    // 4. Download music
    console.log("Step 3 — Downloading music...");
    await getFile(musicInput, musicPath);
    if (fs.statSync(musicPath).size < 100) throw new Error("Music file too small");

    console.log("Files ready — video: " + fs.statSync(videoPath).size +
      " voice: " + fs.statSync(voicePath).size +
      " music: " + fs.statSync(musicPath).size);

    // 5. FFmpeg final merge — music starts from 0, voice from 0
    console.log("Step 4 — FFmpeg merge...");
    await new Promise(function(resolve, reject) {
      ffmpeg()
        .input(videoPath)
        .input(voicePath)
        .input(musicPath)
        .complexFilter([
          // Music fades in from start, voice at full volume
          "[2:a]volume=0.20,afade=t=in:st=0:d=2[music]",
          "[1:a]volume=1.0[voice]",
          "[voice][music]amix=inputs=2:duration=first:dropout_transition=2[audio]"
        ])
        .outputOptions([
          "-map 0:v",
          "-map [audio]",
          "-c:v copy",
          "-c:a aac",
          "-b:a 192k",
          "-shortest",
          "-movflags faststart"
        ])
        .output(outputPath)
        .on("end", function() {
          console.log("FFmpeg merge complete");
          resolve();
        })
        .on("error", function(err) {
          console.error("FFmpeg error: " + err.message);
          reject(err);
        })
        .run();
    });

    var fileSizeMb = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    var serverUrl = process.env.RAILWAY_STATIC_URL || "kidscartoon-production.up.railway.app";
    if (serverUrl.indexOf("http") !== 0) serverUrl = "https://" + serverUrl;

    var finalUrl = serverUrl + "/outputs/final_" + jobId + ".mp4";
    console.log("Done — " + fileSizeMb + "MB — " + finalUrl);

    res.json({
      status: "success",
      final_video_url: finalUrl,
      file_size_mb: fileSizeMb,
      job_id: jobId,
      duration_secs: audioDuration
    });

  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    console.error("FAILED:", err.message);
    res.status(500).json({ error: err.message, status: "failed" });
  }
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Kids merger v6.0 on port " + PORT);
});
