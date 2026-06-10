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
  if (!input) {
    throw new Error("Empty input for: " + dest);
  }

  var inputStr = String(input).trim();

  // Check if it is base64 — does not start with http
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

  // It is a URL — download it
  console.log("Downloading: " + inputStr.substring(0, 120));

  var res = await fetch(inputStr, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KidsMerger/1.0)"
    }
  });

  if (!res.ok) {
    throw new Error("Download failed: " + inputStr.substring(0, 80) + " status: " + res.status);
  }

  return new Promise(function(resolve, reject) {
    var stream = fs.createWriteStream(dest);
    res.body.pipe(stream);
    stream.on("finish", function() {
      console.log("Downloaded to: " + dest + " size: " + fs.statSync(dest).size + " bytes");
      resolve();
    });
    stream.on("error", reject);
  });
}

// Convert a static image to a looping MP4 video
async function imageToVideo(imagePath, outputVideoPath, durationSecs) {
  console.log("Converting image to video — duration: " + durationSecs + "s");
  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(imagePath)
      .inputOptions([
        "-loop 1",
        "-framerate 25"
      ])
      .outputOptions([
        "-c:v libx264",
        "-t " + durationSecs,
        "-pix_fmt yuv420p",
        "-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "-preset fast",
        "-crf 23"
      ])
      .output(outputVideoPath)
      .on("start", function(cmd) {
        console.log("FFmpeg image→video cmd: " + cmd.substring(0, 100));
      })
      .on("end", function() {
        console.log("Image→video done: " + outputVideoPath);
        resolve();
      })
      .on("error", function(err) {
        console.error("Image→video error: " + err.message);
        reject(err);
      })
      .run();
  });
}

// Get audio duration in seconds using FFmpeg probe
async function getAudioDuration(audioPath) {
  return new Promise(function(resolve) {
    ffmpeg.ffprobe(audioPath, function(err, metadata) {
      if (err || !metadata || !metadata.format || !metadata.format.duration) {
        console.log("Could not probe audio duration — defaulting to 120s");
        resolve(120);
      } else {
        var dur = Math.ceil(metadata.format.duration) + 2;
        console.log("Audio duration: " + dur + "s");
        resolve(dur);
      }
    });
  });
}

// Health check
app.get("/", function(req, res) {
  res.json({ status: "kids-merger running", version: "4.0" });
});

app.post("/merge", async function(req, res) {
  var videoInput = req.body.video_url;
  var voiceInput = req.body.voice_url;
  var musicInput = req.body.music_url;

  console.log("--- Merge request received ---");
  console.log("video_url:", videoInput ? videoInput.substring(0, 80) : "MISSING");
  console.log("voice_url:", voiceInput ? voiceInput.substring(0, 80) : "MISSING");
  console.log("music_url:", musicInput ? musicInput.substring(0, 80) : "MISSING");

  if (!voiceInput) {
    return res.status(400).json({
      error: "Missing voice_url",
      status: "failed"
    });
  }

  // Use fallback music if not provided
  if (!musicInput) {
    musicInput = "https://files.freemusicarchive.org/storage-freemusicarchive-org/music/WFMU/Broke_For_Free/Directionless_EP/Broke_For_Free_-_01_-_Night_Owl.mp3";
    console.log("No music_url provided — using default fallback music");
  }

  // Use fallback image if no video provided
  if (!videoInput) {
    videoInput = "https://image.pollinations.ai/prompt/A%20vibrant%20colorful%20cartoon%20space%20adventure%20for%20kids";
    console.log("No video_url provided — using fallback image");
  }

  var jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  var rawMediaPath = path.join(tmpDir, "raw_media");
  var videoPath = path.join(tmpDir, "video.mp4");
  var voicePath = path.join(tmpDir, "voice.mp3");
  var musicPath = path.join(tmpDir, "music.mp3");
  var outputPath = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");

  try {
    // Download voice first so we can get its duration
    console.log("Getting voice...");
    await getFile(voiceInput, voicePath);
    var voiceSize = fs.statSync(voicePath).size;
    if (voiceSize < 100) throw new Error("Voice file too small — download may have failed");

    // Get audio duration to match video length
    var audioDuration = await getAudioDuration(voicePath);

    // Handle video_url — detect if it is an image (Pollinations or image extension)
    var videoInputStr = String(videoInput).trim();
    var isImage = (
      videoInputStr.indexOf("pollinations.ai") !== -1 ||
      videoInputStr.indexOf(".jpg") !== -1 ||
      videoInputStr.indexOf(".jpeg") !== -1 ||
      videoInputStr.indexOf(".png") !== -1 ||
      videoInputStr.indexOf(".webp") !== -1
    );

    if (isImage) {
      console.log("Image URL detected — will convert to looping video");
      await getFile(videoInput, rawMediaPath + ".jpg");
      await imageToVideo(rawMediaPath + ".jpg", videoPath, audioDuration);
    } else {
      console.log("Video URL detected — downloading directly");
      await getFile(videoInput, videoPath);
    }

    var videoSize = fs.statSync(videoPath).size;
    if (videoSize < 1000) throw new Error("Video file too small — conversion may have failed");

    // Download music
    console.log("Getting music...");
    await getFile(musicInput, musicPath);
    var musicSize = fs.statSync(musicPath).size;
    if (musicSize < 100) throw new Error("Music file too small — download may have failed");

    console.log("File sizes — video: " + videoSize + " voice: " + voiceSize + " music: " + musicSize);
    console.log("Running FFmpeg final merge...");

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
          "-c:v libx264",
          "-c:a aac",
          "-shortest",
          "-movflags faststart",
          "-preset fast"
        ])
        .output(outputPath)
        .on("start", function(cmd) {
          console.log("FFmpeg merge cmd: " + cmd.substring(0, 100));
        })
        .on("end", function() {
          console.log("FFmpeg merge done: " + jobId);
          resolve();
        })
        .on("error", function(err) {
          console.error("FFmpeg merge error: " + err.message);
          reject(err);
        })
        .run();
    });

    var stats = fs.statSync(outputPath);
    var fileSizeMb = (stats.size / (1024 * 1024)).toFixed(1);

    // Cleanup temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Build output URL
    var serverUrl = process.env.RAILWAY_STATIC_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      "http://localhost:3000";

    if (serverUrl.indexOf("http") !== 0) {
      serverUrl = "https://" + serverUrl;
    }

    console.log("Success — output: " + fileSizeMb + "MB — " + serverUrl);

    res.json({
      status: "success",
      final_video_url: serverUrl + "/outputs/final_" + jobId + ".mp4",
      file_size_mb: fileSizeMb,
      job_id: jobId,
      audio_duration_secs: audioDuration
    });

  } catch (err) {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.error("Error:", err.message);
    res.status(500).json({
      error: err.message,
      status: "failed"
    });
  }
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Kids merger v4.0 on port " + PORT);
});
