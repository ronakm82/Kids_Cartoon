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

// --- Disk-based job persistence ---
function saveJob(jobId, data) {
  try {
    fs.writeFileSync(path.join(JOBS_DIR, jobId + ".json"), JSON.stringify(data));
  } catch (e) { console.log("saveJob error: " + e.message); }
}

function loadJob(jobId) {
  try {
    var f = path.join(JOBS_DIR, jobId + ".json");
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) { return null; }
}

async function getFile(input, dest) {
  if (!input) throw new Error("Empty input for: " + dest);
  var inputStr = String(input).trim();

  console.log("Downloading: " + inputStr.substring(0, 100));
  var res = await fetch(inputStr, {
    headers: { "User-Agent": "Mozilla/5.0 (KidsMerger/1.0)" },
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

async function getAudioDuration(audioPath) {
  return new Promise(function(resolve) {
    ffmpeg.ffprobe(audioPath, function(err, metadata) {
      if (err || !metadata || !metadata.format || !metadata.format.duration) {
        console.log("Audio probe failed — defaulting 120s");
        resolve(120);
      } else {
        var dur = Math.ceil(metadata.format.duration) + 1;
        console.log("Audio duration: " + dur + "s");
        resolve(dur);
      }
    });
  });
}

// Convert image to video with specified duration
async function imageToVideoClip(imagePath, outputPath, durationSecs, isLastScene) {
  console.log("Creating video clip from image: " + durationSecs + "s");
  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1", "-framerate 24"])
      .outputOptions([
        "-c:v libx264",
        "-t " + durationSecs,
        "-pix_fmt yuv420p",
        "-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "-preset faster",
        "-crf 22"
      ])
      .output(outputPath)
      .on("end", function() {
        console.log("Clip done: " + fs.statSync(outputPath).size + " bytes");
        resolve();
      })
      .on("error", function(err) {
        reject(new Error("imageToVideoClip: " + err.message));
      })
      .run();
  });
}

// Concatenate multiple video clips with fade transitions
async function concatenateClips(clipPaths, outputPath) {
  console.log("Concatenating " + clipPaths.length + " clips with fade transitions...");

  // Create concat demuxer file
  var concatFile = outputPath.replace(/\.mp4$/, "_concat.txt");
  var concatContent = clipPaths.map(function(p) {
    return "file '" + p + "'";
  }).join("\n");

  fs.writeFileSync(concatFile, concatContent);

  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(concatFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions([
        "-c:v libx264",
        "-c:a aac",
        "-pix_fmt yuv420p",
        "-vf \"[0:v]fade=t=out:st=" + (clipPaths.length - 1) + ":d=0.5[v]\" -map \"[v]\" -map 0:a",
        "-preset faster",
        "-crf 22"
      ])
      .output(outputPath)
      .on("end", function() {
        console.log("Concatenation done: " + fs.statSync(outputPath).size + " bytes");
        fs.unlinkSync(concatFile);
        resolve();
      })
      .on("error", function(err) {
        fs.unlinkSync(concatFile);
        reject(new Error("concatenateClips: " + err.message));
      })
      .run();
  });
}

// Professional video assembly — images + voice + music
async function assembleVideoWithAudio(videoPath, voicePath, musicPath, outputPath) {
  console.log("Professional video assembly with audio mixing...");

  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(videoPath)
      .input(voicePath)
      .input(musicPath)
      .complexFilter([
        // Voice at full volume
        "[1:a]aformat=sample_rates=44100[voice]",
        // Music fades in, stays low during voice, fades out
        "[2:a]volume=0.15,afade=t=in:st=0:d=2[music]",
        // Mix voice (louder) and music (background)
        "[voice][music]amix=inputs=2:duration=first:dropout_transition=1[audio]"
      ])
      .outputOptions([
        "-map 0:v:0",
        "-map [audio]",
        "-c:v copy",
        "-c:a aac",
        "-b:a 192k",
        "-shortest",
        "-movflags faststart",
        "-y"
      ])
      .output(outputPath)
      .on("end", function() {
        console.log("Assembly complete: " + fs.statSync(outputPath).size + " bytes");
        resolve();
      })
      .on("error", function(err) {
        reject(new Error("assembleVideo: " + err.message));
      })
      .run();
  });
}

// Main processing function
async function processVideo(jobId, voiceInput, musicInput, scenesInput, storyTitle) {
  saveJob(jobId, { status: "processing", stage: "starting", started: Date.now() });

  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  var voicePath = path.join(tmpDir, "voice.mp3");
  var musicPath = path.join(tmpDir, "music.mp3");
  var outputPath = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");

  var serverUrl = process.env.RAILWAY_STATIC_URL || "kidscartoon-production.up.railway.app";
  if (serverUrl.indexOf("http") !== 0) serverUrl = "https://" + serverUrl;

  try {
    if (!scenesInput || scenesInput.length === 0) {
      throw new Error("No scenes provided");
    }

    console.log("[" + jobId + "] Processing " + scenesInput.length + " scenes");
    saveJob(jobId, { status: "processing", stage: "downloading_assets" });

    // 1 — Download voice
    console.log("[" + jobId + "] Downloading voice...");
    await getFile(voiceInput, voicePath);
    if (fs.statSync(voicePath).size < 100) throw new Error("Voice file too small");

    // 2 — Get voice duration
    await new Promise(function(r) { setTimeout(r, 1000); });
    var totalDuration = await getAudioDuration(voicePath);
    if (totalDuration < 10) totalDuration = 120;
    console.log("[" + jobId + "] Total duration: " + totalDuration + "s");

    // 3 — Calculate duration per scene
    var scenes = scenesInput;
    var totalChars = scenes.reduce(function(sum, s) { return sum + (s.characterCount || s.estimatedDuration * 20); }, 0);
    var sceneDurations = scenes.map(function(scene) {
      var ratio = (scene.characterCount || scene.estimatedDuration * 20) / totalChars;
      return Math.max(3, Math.round(ratio * totalDuration));
    });

    // Adjust if sum doesn't match
    var sumDurations = sceneDurations.reduce(function(a, b) { return a + b; }, 0);
    if (sumDurations !== totalDuration) {
      var diff = totalDuration - sumDurations;
      sceneDurations[sceneDurations.length - 1] += diff;
    }

    console.log("[" + jobId + "] Scene durations: " + sceneDurations.join(", "));

    // 4 — Download images and create clips
    console.log("[" + jobId + "] Creating scene video clips...");
    saveJob(jobId, { status: "processing", stage: "processing_scenes", totalScenes: scenes.length });

    var clipPaths = [];
    for (var i = 0; i < scenes.length; i++) {
      var scene = scenes[i];
      var duration = sceneDurations[i];
      var imagePath = path.join(tmpDir, "scene_" + i + ".jpg");
      var clipPath = path.join(tmpDir, "clip_" + i + ".mp4");

      console.log("[" + jobId + "] Scene " + (i + 1) + "/" + scenes.length + " (" + duration + "s)");
      await getFile(scene.imageUrl, imagePath);
      if (fs.statSync(imagePath).size < 5000) throw new Error("Scene " + (i + 1) + " image too small");

      await imageToVideoClip(imagePath, clipPath, duration, i === scenes.length - 1);
      clipPaths.push(clipPath);

      // Update progress
      saveJob(jobId, {
        status: "processing",
        stage: "processing_scenes",
        progress: Math.round((i + 1) / scenes.length * 100) + "%",
        totalScenes: scenes.length
      });
    }

    // 5 — Concatenate clips
    console.log("[" + jobId + "] Concatenating " + clipPaths.length + " clips...");
    saveJob(jobId, { status: "processing", stage: "concatenating" });
    var concatPath = path.join(tmpDir, "concatenated.mp4");
    await concatenateClips(clipPaths, concatPath);

    // 6 — Download music
    console.log("[" + jobId + "] Downloading music...");
    saveJob(jobId, { status: "processing", stage: "downloading_music" });
    var musicUrl = musicInput || "https://files.freemusicarchive.org/storage-freemusicarchive-org/music/WFMU/Broke_For_Free/Directionless_EP/Broke_For_Free_-_01_-_Night_Owl.mp3";
    await getFile(musicUrl, musicPath);
    if (fs.statSync(musicPath).size < 100) throw new Error("Music file too small");

    // 7 — Professional audio assembly
    console.log("[" + jobId + "] Professional audio assembly...");
    saveJob(jobId, { status: "processing", stage: "assembling_audio" });
    await assembleVideoWithAudio(concatPath, voicePath, musicPath, outputPath);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    var fileSizeMb = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    var finalUrl = serverUrl + "/outputs/final_" + jobId + ".mp4";

    console.log("[" + jobId + "] SUCCESS — " + fileSizeMb + "MB");

    saveJob(jobId, {
      status: "done",
      final_video_url: finalUrl,
      file_size_mb: fileSizeMb,
      job_id: jobId,
      duration_secs: totalDuration,
      scenes: scenes.length,
      completed: Date.now()
    });

  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    console.error("[" + jobId + "] FAILED: " + err.message);
    saveJob(jobId, { status: "failed", error: err.message, job_id: jobId });
  }
}

// --- Routes ---

app.get("/", function(req, res) {
  res.json({ status: "kids-merger-pro running", version: "9.0" });
});

app.get("/test", function(req, res) {
  res.json({ version: "9.0", status: "Professional scene-based video generation" });
});

app.get("/status/:jobId", function(req, res) {
  var job = loadJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found", status: "not_found" });
  res.json(job);
});

app.post("/merge", function(req, res) {
  var voiceInput = req.body.voice_url;
  var musicInput = req.body.music_url;
  var scenesInput = req.body.scenes;
  var storyTitle = req.body.title || "A Kids Story Adventure";

  console.log("--- Merge request v9.0 Professional ---");
  console.log("voice_url:", voiceInput ? voiceInput.substring(0, 80) : "MISSING");
  console.log("scenes:", scenesInput ? scenesInput.length : "MISSING");
  console.log("title:", storyTitle);

  if (!voiceInput || !scenesInput || scenesInput.length === 0) {
    return res.status(400).json({
      error: "Missing voice_url or scenes",
      status: "failed"
    });
  }

  var jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  var serverUrl = process.env.RAILWAY_STATIC_URL || "kidscartoon-production.up.railway.app";
  if (serverUrl.indexOf("http") !== 0) serverUrl = "https://" + serverUrl;

  res.json({
    status: "processing",
    job_id: jobId,
    status_url: serverUrl + "/status/" + jobId,
    message: "Professional video generation started. Check status_url in 7 minutes."
  });

  // Process in background
  processVideo(jobId, voiceInput, musicInput, scenesInput, storyTitle);
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Kids merger v9.0 Professional on port " + PORT);
});
