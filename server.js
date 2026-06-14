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

async function getFile(input, dest) {
  var inputStr = String(input).trim();
  
  // Handle base64 data URLs (from ElevenLabs, etc)
  if (inputStr.startsWith('data:')) {
    console.log("Detecting base64 data URL");
    var base64Data = inputStr.split(',')[1];
    if (!base64Data) throw new Error("Invalid data URL");
    
    var buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(dest, buffer);
    console.log("✓ Saved base64 data: " + dest + " (" + buffer.length + " bytes)");
    return;
  }
  
  // Handle HTTP/HTTPS URLs
  console.log("Downloading: " + inputStr.substring(0, 80));
  var res = await fetch(inputStr, {
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
    timeout: 30000
  });
  
  if (!res.ok) throw new Error("Download failed: " + res.status);
  
  var buffer = await res.buffer();
  if (buffer.length < 100) throw new Error("Downloaded file too small: " + buffer.length + " bytes");
  
  fs.writeFileSync(dest, buffer);
  console.log("✓ Saved: " + path.basename(dest) + " (" + buffer.length + " bytes)");
}

function createVideoWithAudio(imagePath, voicePath, musicPath, outputPath) {
  console.log("Creating video with voice + music mix...");
  
  var cmd = ffmpegPath;
  
  if (musicPath && fs.existsSync(musicPath)) {
    // Mix voice + music
    cmd += ' -loop 1 -i "' + imagePath + '"' +
           ' -i "' + voicePath + '"' +
           ' -i "' + musicPath + '"' +
           ' -filter_complex "[1:a]volume=1.0[voice];[2:a]volume=0.3,afade=t=in:st=0:d=2[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=1[audio]"' +
           ' -map 0:v:0 -map "[audio]"' +
           ' -c:v libx264 -c:a aac -pix_fmt yuv420p -shortest -y "' + outputPath + '"';
  } else {
    // Voice only (no music)
    cmd += ' -loop 1 -i "' + imagePath + '"' +
           ' -i "' + voicePath + '"' +
           ' -c:v libx264 -c:a aac -pix_fmt yuv420p -shortest -y "' + outputPath + '"';
  }
  
  console.log("FFmpeg command: " + cmd.substring(0, 100) + "...");
  
  try {
    var result = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
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

async function processVideo(jobId, voiceUrl, musicUrl, scenesInput, serverUrl) {
  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });
  
  var voicePath = path.join(tmpDir, "voice.mp3");
  var musicPath = path.join(tmpDir, "music.mp3");
  var imagePath = path.join(tmpDir, "image.jpg");
  var outputPath = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");
  
  try {
    console.log("[" + jobId + "] Starting video generation with audio mix");
    
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
    if (musicUrl) console.log("[" + jobId + "] Music: " + musicUrl.substring(0, 80));
    
    // Download voice
    await getFile(voiceUrl, voicePath);
    
    // Download music if provided
    if (musicUrl) {
      try {
        await getFile(musicUrl, musicPath);
        console.log("[" + jobId + "] Music downloaded successfully");
      } catch (musicErr) {
        console.log("[" + jobId + "] Music download failed, continuing without music: " + musicErr.message);
        musicPath = null;
      }
    }
    
    // Download image
    await getFile(imageUrl, imagePath);
    
    // Verify files exist
    if (!fs.existsSync(voicePath)) throw new Error("Voice file missing");
    if (!fs.existsSync(imagePath)) throw new Error("Image file missing");
    
    var voiceSize = fs.statSync(voicePath).size;
    var imageSize = fs.statSync(imagePath).size;
    var musicSize = musicPath && fs.existsSync(musicPath) ? fs.statSync(musicPath).size : 0;
    
    console.log("[" + jobId + "] Files ready: voice=" + voiceSize + "B, image=" + imageSize + "B, music=" + musicSize + "B");
    
    // Create video with audio mix
    createVideoWithAudio(imagePath, voicePath, musicPath, outputPath);
    
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
  res.json({ status: "kids-merger online", version: "15.0" });
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
  var musicUrl = req.body.music_url;
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
  
  processVideo(jobId, voiceUrl, musicUrl, scenesInput, serverUrl);
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log("Kids Merger v15.0 running on port " + PORT);
});
