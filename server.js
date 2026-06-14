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
var JOBS_DIR = path.join(__dirname, "jobs");

[OUTPUT_DIR, JOBS_DIR].forEach(function(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function saveJob(jobId, data) {
  try {
    fs.writeFileSync(path.join(JOBS_DIR, jobId + ".json"), JSON.stringify(data));
  } catch (e) { console.log("saveJob error: " + e.message); }
}

async function getFile(input, dest) {
  if (!input) throw new Error("Empty input URL");
  var res = await fetch(String(input).trim(), {
    headers: { "User-Agent": "Mozilla/5.0 (KidsMerger/1.0)" },
    redirect: "follow"
  });
  if (!res.ok) throw new Error("Download failed status: " + res.status);

  return new Promise(function(resolve, reject) {
    var stream = fs.createWriteStream(dest);
    res.body.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function getAudioDuration(audioPath) {
  return new Promise(function(resolve) {
    ffmpeg.ffprobe(audioPath, function(err, metadata) {
      if (err || !metadata || !metadata.format || !metadata.format.duration) {
        resolve(120);
      } else {
        resolve(Math.ceil(metadata.format.duration) + 1);
      }
    });
  });
}

async function imageToVideoClip(imagePath, outputPath, durationSecs) {
  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1", "-framerate 24"])
      .outputOptions([
        "-threads 1",
        "-c:v libx264",
        "-t " + durationSecs,
        "-pix_fmt yuv420p",
        "-vf scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
        "-preset ultrafast",
        "-crf 28"
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function assembleVideoWithAudio(videoPath, voicePath, outputPath) {
  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(videoPath)
      .input(voicePath)
      .outputOptions([
        "-threads 1",
        "-map 0:v:0",       // Explicitly map video track from input 0
        "-map 1:a:0",       // Explicitly map audio track from input 1
        "-c:v copy",        // Direct stream copy the video frames (instant, zero RAM overhead)
        "-c:a aac",         // Cleanly encode the audio channel to AAC
        "-b:a 192k",
        "-y"
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function processVideo(jobId, voiceInput, scenesInput, serverUrl) {
  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  var voicePath = path.join(tmpDir, "voice.mp3");
  var outputPath = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");

  try {
    var scenes = scenesInput;
    if (typeof scenes === "string") {
      var trimmed = scenes.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try { scenes = JSON.parse(trimmed); } catch (e) {}
      }
      if (typeof scenes === "string") {
        scenes = scenes.split(",").map(function(url) { return { imageUrl: url.trim() }; });
      }
    }
    if (!Array.isArray(scenes)) {
      if (scenes && (scenes.imageUrl || scenes.url)) { scenes = [scenes]; }
      else { throw new Error("Invalid scenes layout"); }
    }

    console.log("[" + jobId + "] Downloading voice asset...");
    await getFile(voiceInput, voicePath);
    var totalDuration = await getAudioDuration(voicePath);

    var clipPaths = [];
    var durationPerScene = Math.max(3, Math.round(totalDuration / scenes.length));

    for (var i = 0; i < scenes.length; i++) {
      var scene = scenes[i];
      var imagePath = path.join(tmpDir, "scene_" + i + ".jpg");
      var clipPath = path.join(tmpDir, "clip_" + i + ".mp4");

      console.log("[" + jobId + "] Rendering scene " + (i + 1) + "/" + scenes.length);
      
      if (scene.imageUrl && scene.imageUrl.startsWith("data:image")) {
        var base64Data = scene.imageUrl.split(";base64,").pop();
        await fs.promises.writeFile(imagePath, Buffer.from(base64Data, "base64"));
      } else {
        await getFile(scene.imageUrl, imagePath);
      }

      await imageToVideoClip(imagePath, clipPath, durationPerScene);
      clipPaths.push(clipPath);
      try { await fs.promises.unlink(imagePath); } catch(e){}
    }

    var concatPath = clipPaths[0];
    if (clipPaths.length > 1) {
      concatPath = path.join(tmpDir, "concatenated.mp4");
      var concatFile = path.join(tmpDir, "list.txt");
      var concatContent = clipPaths.map(function(p) { return "file '" + p + "'"; }).join("\n");
      await fs.promises.writeFile(concatFile, concatContent);

      await new Promise(function(resolve, reject) {
        ffmpeg()
          .input(concatFile)
          .inputOptions(["-f concat", "-safe 0"])
          .outputOptions(["-threads 1", "-c:v copy", "-y"])
          .output(concatPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    }

    console.log("[" + jobId + "] Assembling final video track layout...");
    await assembleVideoWithAudio(concatPath, voicePath, outputPath);
    
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}

    var fileSizeMb = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    saveJob(jobId, {
      status: "done",
      final_video_url: serverUrl + "/outputs/final_" + jobId + ".mp4",
      file_size_mb: fileSizeMb,
      job_id: jobId,
      duration_secs: totalDuration
    });
    console.log("[" + jobId + "] Video generation successful!");

  } catch (err) {
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
    console.error("[" + jobId + "] Processing failed: " + err.message);
    saveJob(jobId, { status: "failed", error: err.message, job_id: jobId });
  }
}

app.get("/", function(req, res) {
  res.json({ status: "kids-merger-pro running smoothly", version: "10.0" });
});

app.get("/status/:jobId", function(req, res) {
  try {
    var f = path.join(JOBS_DIR, req.params.jobId + ".json");
    if (!fs.existsSync(f)) return res.status(404).json({ error: "Job not found" });
    res.json(JSON.parse(fs.readFileSync(f, "utf8")));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/merge", function(req, res) {
  var voiceInput = req.body.voice_url;
  var scenesInput = req.body.scenes;

  if (!voiceInput || !scenesInput) {
    return res.status(400).json({ error: "Missing required voice_url or scenes" });
  }

  var jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  var serverUrl = process.env.RAILWAY_STATIC_URL || "kidscartoon-production.up.railway.app";
  if (serverUrl.indexOf("http") !== 0) serverUrl = "https://" + serverUrl;

  try {
    fs.writeFileSync(path.join(JOBS_DIR, jobId + ".json"), JSON.stringify({ status: "processing", started: Date.now() }));
  } catch(e){}

  res.json({
    status: "processing",
    job_id: jobId,
    status_url: serverUrl + "/status/" + jobId
  });

  // Call the local function directly
  processVideo(jobId, voiceInput, scenesInput, serverUrl);
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Server listening cleanly on port: " + PORT);
});
