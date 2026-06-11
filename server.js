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
      console.log("Wrote base64 to: " + dest + " size: " + fs.statSync(dest).size + " bytes");
      return;
    } catch (e) {
      throw new Error("Failed to decode base64 for " + dest + ": " + e.message);
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
      console.log("Downloaded: " + dest + " size: " + fs.statSync(dest).size + " bytes");
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
        console.log("Could not probe audio — defaulting to 120s. Error: " + (err ? err.message : "no metadata"));
        resolve(120);
      } else {
        var dur = Math.ceil(metadata.format.duration) + 2;
        console.log("Audio duration detected: " + dur + "s");
        resolve(dur);
      }
    });
  });
}

// Convert static image to looping MP4 video
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
        console.error("Image to video error: " + err.message);
        reject(err);
      })
      .run();
  });
}

// Detect if a URL points to an image rather than a video
function isImageUrl(urlStr) {
  return (
    urlStr.indexOf("picsum.photos") !== -1 ||
    urlStr.indexOf("pollinations.ai") !== -1 ||
    urlStr.indexOf("unsplash.com") !== -1 ||
    urlStr.indexOf("imgur.com") !== -1 ||
    urlStr.indexOf(".jpg") !== -1 ||
    urlStr.indexOf(".jpeg") !== -1 ||
    urlStr.indexOf(".png") !== -1 ||
    urlStr.indexOf(".webp") !== -1 ||
    urlStr.indexOf(".gif") !== -1
  );
}

// Health check
app.get("/", function(req, res) {
  res.json({ status: "kids-merger running", version: "5.0" });
});

// Debug env check
app.get("/test", function(req, res) {
  res.json({
    version: "5.0",
    railway_url: process.env.RAILWAY_STATIC_URL || "NOT SET",
    port: process.env.PORT || "3000"
  });
});

app.post("/merge", async function(req, res) {
  var videoInput = req.body.video_url;
  var voiceInput = req.body.voice_url;
  var musicInput = req.body.music_url;

  console.log("--- Merge request v5.0 ---");
  console.log("video_url:", videoInput ? videoInput.substring(0, 80) : "MISSING");
  console.log("voice_url:", voiceInput ? voiceInput.substring(0, 80) : "MISSING");
  console.log("music_url:", musicInput ? musicInput.substring(0, 80) : "MISSING");

  if (!voiceInput) {
    return res.status(400).json({ error: "Missing voice_url", status: "failed" });
  }

  // Fallbacks
  if (!musicInput) {
    musicInput = "https://files.freemusicarchive.org/storage-freemusicarchive-org/music/WFMU/Broke_For_Free/Directionless_EP/Broke_For_Free_-_01_-_Night_Owl.mp3";
    console.log("Using fallback music");
  }
  if (!videoInput) {
    videoInput = "https://picsum.photos/seed/cartoon/1280/720";
    console.log("Using fallback image");
  }

  var jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  var imagePath  = path.join(tmpDir, "input_image.jpg");
  var videoPath  = path.join(tmpDir, "video.mp4");
  var voicePath  = path.join(tmpDir, "voice.mp3");
  var musicPath  = path.join(tmpDir, "music.mp3");
  var outputPath = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");

  try {
    // 1. Download voice first — need duration to size the video
    console.log("Step 1 — Getting voice...");
    await getFile(voiceInput, voicePath);
    if (fs.statSync(voicePath).size < 100) throw new Error("Voice file too small");

    // 2. Probe audio duration
    var audioDuration = await getAudioDuration(voicePath);
    if (audioDuration < 5) audioDuration = 120;
    console.log("Final duration target: " + audioDuration + "s");

    // 3. Handle video or image input
    var videoInputStr = String(videoInput).trim();
    if (isImageUrl(videoInputStr)) {
      console.log("Step 2 — Image detected, converting to " + audioDuration + "s video...");
      await getFile(videoInput, imagePath);
      if (fs.statSync(imagePath).size < 1000) throw new Error("Image file too small — download failed");
      await imageToVideo(imagePath, videoPath, audioDuration);
    } else {
      console.log("Step 2 — Downloading video directly...");
      await getFile(videoInput, videoPath);
    }
    if (fs.statSync(videoPath).size < 1000) throw new Error("Video file too small after processing");

    // 4. Download music
    console.log("Step 3 — Getting music...");
    await getFile(musicInput, musicPath);
    if (fs.statSync(musicPath).size < 100) throw new Error("Music file too small");

    console.log("All files ready — video: " + fs.statSync(videoPath).size +
      " voice: " + fs.statSync(voicePath).size +
      " music: " + fs.statSync(musicPath).size);

    // 5. FFmpeg final merge
    console.log("Step 4 — Running FFmpeg merge...");
    await new Promise(function(resolve, reject) {
      ffmpeg()
        .input(videoPath)
        .input(voicePath)
        .input(musicPath)
        .complexFilter([
          "[1:a]volume=1.0[voice]",
          "[2:a]volume=0.25[music]",
          "[voice][music]amix=inputs=2:duration=first[audio]"
        ])
        .outputOptions([
          "-map 0:v",
          "-map [audio]",
          "-c:v copy",
          "-c:a aac",
          "-shortest",
          "-movflags faststart"
        ])
        .output(outputPath)
        .on("end", function() {
          console.log("FFmpeg merge done: " + jobId);
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

    // Build correct output URL
    var serverUrl = process.env.RAILWAY_STATIC_URL || "";
    if (!serverUrl) {
      serverUrl = "kidscartoon-production.up.railway.app";
    }
    if (serverUrl.indexOf("http") !== 0) {
      serverUrl = "https://" + serverUrl;
    }

    var finalUrl = serverUrl + "/outputs/final_" + jobId + ".mp4";
    console.log("Success — " + fileSizeMb + "MB — " + finalUrl);

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
  console.log("Kids merger v5.0 on port " + PORT);
});
