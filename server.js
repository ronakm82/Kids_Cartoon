var fetch = require("node-fetch");
var ffmpeg = require("fluent-ffmpeg");
var ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
var fs = require("fs");
var path = require("path");

ffmpeg.setFfmpegPath(ffmpegPath);

var OUTPUT_DIR = path.join(__dirname, "outputs");
var JOBS_DIR = path.join(__dirname, "jobs");

function saveJob(jobId, data) {
  try {
    fs.writeFileSync(path.join(JOBS_DIR, jobId + ".json"), JSON.stringify(data));
  } catch (e) { console.log("saveJob error: " + e.message); }
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
        "-c:v libx264",
        "-t " + durationSecs,
        "-pix_fmt yuv420p",
        "-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "-preset faster",
        "-crf 22"
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function concatenateClips(clipPaths, outputPath) {
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
    return;
  }
  var concatFile = outputPath.replace(/\.mp4$/, "_concat.txt");
  var concatContent = clipPaths.map(function(p) { return "file '" + p + "'"; }).join("\n");
  fs.writeFileSync(concatFile, concatContent);

  return new Promise(function(resolve, reject) {
    var fadeIndex = Math.max(0, clipPaths.length - 1);
    ffmpeg()
      .input(concatFile)
      .inputOptions(["-f concat", "-safe 0"])
      .videoFilters("[0:v]fade=t=out:st=" + fadeIndex + ":d=0.5[v]")
      .outputOptions(["-c:v libx264", "-pix_fmt yuv420p", "-map [v]", "-preset faster", "-crf 22"])
      .output(outputPath)
      .on("end", function() {
        if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
        resolve();
      })
      .on("error", function(err) {
        if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
        reject(err);
      })
      .run();
  });
}

async function assembleVideoWithAudio(videoPath, voicePath, musicPath, outputPath) {
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
      .outputOptions(["-map 0:v:0", "-map [audio]", "-c:v copy", "-c:a aac", "-b:a 192k", "-shortest", "-movflags faststart", "-y"])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function processVideo(jobId, voiceInput, musicInput, scenesInput, serverUrl) {
  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  var voicePath = path.join(tmpDir, "voice.mp3");
  var musicPath = path.join(tmpDir, "music.mp3");
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
      else { throw new Error
