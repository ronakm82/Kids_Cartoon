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
    // Strip data URI prefix if present
    var base64Data = inputStr
      .replace(/^data:audio\/mp3;base64,/, "")
      .replace(/^data:audio\/mpeg;base64,/, "")
      .replace(/^data:video\/mp4;base64,/, "");

    try {
      fs.writeFileSync(dest, Buffer.from(base64Data, "base64"));
      console.log("Wrote base64 file to: " + dest +
        " size: " + fs.statSync(dest).size + " bytes");
      return;
    } catch(e) {
      throw new Error("Failed to decode base64 for " + dest + ": " + e.message);
    }
  }

  // It is a URL — download it
  var url = inputStr;
  if (url.indexOf("http") !== 0) {
    url = "https://" + url;
  }

  console.log("Downloading: " + url.substring(0, 100));

  var res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KidsMerger/1.0)"
    }
  });

  if (!res.ok) {
    throw new Error("Download failed: " + url.substring(0, 80) +
      " status: " + res.status);
  }

  return new Promise(function(resolve, reject) {
    var stream = fs.createWriteStream(dest);
    res.body.pipe(stream);
    stream.on("finish", function() {
      console.log("Downloaded to: " + dest +
        " size: " + fs.statSync(dest).size + " bytes");
      resolve();
    });
    stream.on("error", reject);
  });
}

app.get("/", function(req, res) {
  res.json({ status: "kids-merger running", version: "3.0" });
});

app.post("/merge", async function(req, res) {
  var videoInput = req.body.video_url;
  var voiceInput = req.body.voice_url;
  var musicInput = req.body.music_url;

  console.log("Merge request received");
  console.log("video type:", videoInput ?
    (videoInput.indexOf("http") === 0 ? "URL" : "base64") : "MISSING");
  console.log("voice type:", voiceInput ?
    (voiceInput.indexOf("http") === 0 ? "URL" : "base64") : "MISSING");
  console.log("music type:", musicInput ?
    (musicInput.indexOf("http") === 0 ? "URL" : "base64") : "MISSING");

  if (!videoInput || !voiceInput || !musicInput) {
    return res.status(400).json({
      error: "Missing video_url, voice_url or music_url",
      status: "failed"
    });
  }

  var jobId = Date.now() + "_" +
    Math.random().toString(36).substr(2, 6);
  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  var videoPath = path.join(tmpDir, "video.mp4");
  var voicePath = path.join(tmpDir, "voice.mp3");
  var musicPath = path.join(tmpDir, "music.mp3");
  var outputPath = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");

  try {
    console.log("Getting video...");
    await getFile(videoInput, videoPath);

    console.log("Getting voice...");
    await getFile(voiceInput, voicePath);

    console.log("Getting music...");
    await getFile(musicInput, musicPath);

    // Verify all files exist and have content
    var videoSize = fs.statSync(videoPath).size;
    var voiceSize = fs.statSync(voicePath).size;
    var musicSize = fs.statSync(musicPath).size;

    console.log("File sizes — video: " + videoSize +
      " voice: " + voiceSize + " music: " + musicSize);

    if (videoSize < 1000) throw new Error("Video file too small — download may have failed");
    if (voiceSize < 100) throw new Error("Voice file too small — base64 may be empty");
    if (musicSize < 100) throw new Error("Music file too small — download may have failed");

    console.log("Running FFmpeg merge...");

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
          "-movflags faststart"
        ])
        .output(outputPath)
        .on("end", function() {
          console.log("FFmpeg done: " + jobId);
          resolve();
        })
        .on("error", function(err) {
          console.error("FFmpeg error: " + err.message);
          reject(err);
        })
        .run();
    });

    var stats = fs.statSync(outputPath);
    var fileSizeMb = (stats.size / (1024 * 1024)).toFixed(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    var serverUrl = process.env.RAILWAY_STATIC_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      "http://localhost:3000";

    if (serverUrl.indexOf("http") !== 0) {
      serverUrl = "https://" + serverUrl;
    }

    console.log("Success — output: " + fileSizeMb + "MB");

    res.json({
      status: "success",
      final_video_url: serverUrl + "/outputs/final_" + jobId + ".mp4",
      file_size_mb: fileSizeMb,
      job_id: jobId
    });

  } catch(err) {
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
  console.log("Kids merger v3.0 on port " + PORT);
});
