var express = require("express");
var fetch = require("node-fetch");
var ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
var { execSync } = require("child_process");
var fs = require("fs");
var path = require("path");

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

async function downloadFile(url, filepath) {
  console.log("Downloading: " + url.substring(0, 80));
  var res = await fetch(String(url).trim(), {
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
    timeout: 30000
  });
  
  if (!res.ok) throw new Error("Download failed: " + res.status);
  
  var buffer = await res.buffer();
  if (buffer.length < 100) throw new Error("Downloaded file too small: " + buffer.length + " bytes");
  
  fs.writeFileSync(filepath, buffer);
  console.log("✓ Saved: " + path.basename(filepath) + " (" + buffer.length + " bytes)");
}

function createVideo(imagePath, voicePath, outputPath) {
  console.log("Creating video...");
  
  // Build FFmpeg command as string for maximum compatibility
  var cmd = ffmpegPath + 
    ' -loop 1 -i "' + imagePath + '"' +
    ' -i "' + voicePath + '"' +
    ' -c:v libx264 -c:a aac -pix_fmt yuv420p -shortest -y "' + outputPath + '"';
  
  console.log("FFmpeg command: " + cmd.substring(0, 100) + "...");
  
  try {
    var result = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    console.log("✓ Video created successfully");
    
    if (!fs.existsSync(outputPath)) {
      throw new Error("Output file was not created");
    }
    
    var stats = fs.statSync(outputPath);
    console.log("✓ Output file size: " + (stats.size / 1024 / 1024).toFixed(2) + " MB");
    
    if (stats.size < 100000) {
      throw new Error("Output file too small: " + stats.size + " bytes");
    }
  } catch (err) {
    console.error("FFmpeg error: " + err.message);
    throw err;
  }
}

async function processVideo(jobId, voiceUrl, scenesInput, serverUrl) {
  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });
  
  var voicePath = path.join(tmpDir, "voice.mp3");
  var imagePath = path.join(tmpDir, "image.jpg");
  var outputPath = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");
  
  try {
    console.log("[" + jobId + "] Starting video generation");
    
    // Parse scenes
    var scenes = scenesInput;
    if (typeof scenes === "string") {
      try { scenes = JSON.parse(scenes); } catch(e) {}
    }
    if (!Array.isArray(scenes)) {
      scenes = [scenes];
    }
    
    var imageUrl = scenes[0].imageUrl || scenes[0].url;
    if (!imageUrl) throw new Error("No image URL found");
    
    console.log("[" + jobId + "] Image: " + imageUrl.substring(0, 80));
    console.log("[" + jobId + "] Voice: " + voiceUrl.substring(0, 80));
    
    // Download files
    await downloadFile(voiceUrl, voicePath);
    await downloadFile(imageUrl, imagePath);
    
    // Verify files exist
    if (!fs.existsSync(voicePath)) throw new Error("Voice file missing");
    if (!fs.existsSync(imagePath)) throw new Error("Image file missing");
    
    var voiceSize = fs.statSync(voicePath).size;
    var imageSize = fs.statSync(imagePath).size;
    console.log("[" + jobId + "] Files ready: voice=" + voiceSize + "B, image=" + imageSize + "B");
    
    // Create video
    createVideo(imagePath, voicePath, outputPath);
    
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
    
    var finalSize = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
    saveJob(jobId, {
      status: "done",
      final_video_url: serverUrl + "/outputs/final_" + jobId + ".mp4",
      file_size_mb: finalSize,
      job_id: jobId
    });
    
    console.log("[" + jobId + "] ✓ COMPLETE - " + finalSize + " MB");
    
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
    console.error("[" + jobId + "] ✗ FAILED: " + err.message);
    saveJob(jobId, { status: "failed", error: err.message, job_id: jobId });
  }
}

app.get("/", function(req, res) {
  res.json({ status: "kids-merger online", version: "13.0" });
});

app.get("/status/:jobId", function(req, res) {
  try {
    var f = path.join(JOBS_DIR, req.params.jobId + ".json");
    if (!fs.existsSync(f)) return res.status(404).json({ error: "Job not found" });
    res.json(JSON.parse(fs.readFileSync(f, "utf8")));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/merge", function(req, res) {
  var voiceUrl = req.body.voice_url;
  var scenesInput = req.body.scenes;
  
  if (!voiceUrl || !scenesInput) {
    return res.status(400).json({ error: "Missing voice_url or scenes" });
  }
  
  var jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  var serverUrl = process.env.RAILWAY_STATIC_URL || "kidscartoon-production.up.railway.app";
  if (serverUrl.indexOf("http") !== 0) serverUrl = "https://" + serverUrl;
  
  saveJob(jobId, { status: "processing", started: Date.now() });
  
  res.json({
    status: "processing",
    job_id: jobId,
    status_url: serverUrl + "/status/" + jobId
  });
  
  processVideo(jobId, voiceUrl, scenesInput, serverUrl);
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log("Kids Merger v13.0 running on port " + PORT);
});
