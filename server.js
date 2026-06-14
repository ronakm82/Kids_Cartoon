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

// UNIVERSALLY COMPATIBLE SINGLE-PASS ENGINE
async function renderSingleSceneVideo(imagePath, voicePath, outputPath) {
  return new Promise(function(resolve, reject) {
    console.log("Executing single-pass universal hardware multiplexer...");
    ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1"]) // Loop the background image infinitely
      .input(voicePath)          // Read the audio track directly
      .outputOptions([
        "-threads 1",            // Protect Railway memory limits
        "-c:v mpeg4",            // Built-in universal encoder
        "-preset ultrafast",     // Render instantly
        "-c:a aac",              // Encode the audio stream layout to safe AAC
        "-b:a 192k",
        "-pix_fmt yuv420p",      // High web compatibility layout
        // Placed safely in output options to auto-round odd dimensions to even numbers
        "-vf scale='bitand(iw,2)*-1+iw':'bitand(ih,2)*-1+ih'",
        "-shortest"              // Cut cleanly when the voice track ends
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
  var imagePath = path.join(tmpDir, "scene.jpg");
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
    
    // Fallback normalization logic
    if (!Array.isArray(scenes)) {
      if (scenes && (scenes.imageUrl || scenes.url)) { scenes = [scenes]; }
      else { throw new Error("Invalid scenes layout"); }
    }

    // Grab the primary active image asset target
    var targetScene = scenes[0];
    var imageUrl = targetScene.imageUrl || targetScene.url;

    console.log("[" + jobId + "] Downloading voice track component...");
    await getFile(voiceInput, voicePath);

    console.log("[" + jobId + "] Downloading source scene image asset...");
    if (imageUrl && imageUrl.startsWith("data:image")) {
      var base64Data = imageUrl.split(";base64,").pop();
      await fs.promises.writeFile(imagePath, Buffer.from(base64Data, "base64"));
    } else {
      await getFile(imageUrl, imagePath);
    }

    console.log("[" + jobId + "] Running single-pass master composition build...");
    await renderSingleSceneVideo(imagePath, voicePath, outputPath);
    
    // Safe temporary filesystem flush
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}

    var fileSizeMb = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    saveJob(jobId, {
      status: "done",
      final_video_url: serverUrl + "/outputs/final_" + jobId + ".mp4",
      file_size_mb: fileSizeMb,
      job_id: jobId
    });
    console.log("[" + jobId + "] Video generation successful!");

  } catch (err) {
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
    console.error("[" + jobId + "] Processing failed: " + err.message);
    saveJob(jobId, { status: "failed", error: err.message, job_id: jobId });
  }
}

app.get("/", function(req, res) {
  res.json({ status: "kids-merger-pro single-pass active", version: "11.0" });
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

  processVideo(jobId, voiceInput, scenesInput, serverUrl);
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 8080; // Hardmatched directly to your active service port structure
app.listen(PORT, function() {
  console.log("Single-pass architecture online on port: " + PORT);
});
