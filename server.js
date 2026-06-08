const express = require("express");
const fetch = require("node-fetch");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const pipeline = promisify(require("stream").pipeline);

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());

const OUTPUT_DIR = path.join(__dirname, "outputs");
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Download failed: " + url + " status: " + res.status);
  }
  await pipeline(res.body, fs.createWriteStream(dest));
}

app.get("/", function(req, res) {
  res.json({ status: "Kids merger server running" });
});

app.post("/merge", async function(req, res) {
  const { video_url, voice_url, music_url } = req.body;

  if (!video_url || !voice_url || !music_url) {
    return res.status(400).json({
      error: "Missing required fields: video_url, voice_url, music_url"
    });
  }

  const jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  const tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  const videoPath = path.join(tmpDir, "video.mp4");
  const voicePath = path.join(tmpDir, "voice.mp3");
  const musicPath = path.join(tmpDir, "music.mp3");
  const outputPath = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");

  try {
    console.log("Downloading files for job: " + jobId);
    await Promise.all([
      downloadFile(video_url, videoPath),
      downloadFile(voice_url, voicePath),
      downloadFile(music_url, musicPath)
    ]);

    console.log("Merging files for job: " + jobId);

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
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    const stats = fs.statSync(outputPath);
    const fileSizeMb = (stats.size / (1024 * 1024)).toFixed(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    const serverUrl = process.env.RENDER_EXTERNAL_URL ||
      "http://localhost:3000";

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
    console.error("Merge error:", err.message);
    res.status(500).json({
      error: err.message,
      status: "failed"
    });
  }
});

app.use("/outputs", express.static(OUTPUT_DIR));

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Kids merger server running on port " + PORT);
});