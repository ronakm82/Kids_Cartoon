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

async function concatenateClips(clipPaths, outputPath) {
  console.log("Concatenating " + clipPaths.length + " clips with fade transitions...");

  var concatFile = outputPath.replace(/\.mp4$/, "_concat.txt");
  var concatContent = clipPaths.map(function(p) {
    return "file '" + p + "'";
  }).join("\n");

  fs.writeFileSync(concatFile, concatContent);

  return new Promise(function(resolve, reject) {
    var fadeIndex = Math.max(0, clipPaths.length - 1);
    
    ffmpeg()
      .input(concatFile)
      .inputOptions(["-f concat", "-safe 0"])
      .videoFilters("[0:v]fade=t=out:st=" + fadeIndex + ":d=0.5[v]")
      .outputOptions([
        "-c:v libx264",
        "-c:a aac",
        "-pix_fmt yuv420p",
        "-map [v]",
        "-map 0:a",
        "-preset faster",
        "-crf 22"
      ])
      .output(outputPath)
      .on("end", function() {
        console.log("Concatenation done: " + fs.statSync(outputPath).size + " bytes");
        if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
        resolve();
      })
      .on("error", function(err) {
        if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
        reject(new Error("concatenateClips: " + err.message));
      })
      .run();
  });
}

async function assembleVideoWithAudio(videoPath, voicePath, musicPath, outputPath) {
  console.log("Professional video assembly with audio mixing...");

  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(videoPath)
      .input(voicePath)
      .input(musicPath)
      .complexFilter([
        "[1:a]aformat=sample_rates=44100[voice]",
        "[2:a]volume=0.15,afade=t=in:st=0:d=2[music]",
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

    console.log("[" + jobId + "] Processing " + scenesInput.length + " scenes
