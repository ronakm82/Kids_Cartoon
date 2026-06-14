var express = require("express");
var fs = require("fs");
var path = require("path");
var worker = require("./worker");

var app = express();
app.use(express.json({ limit: "50mb" }));

var OUTPUT_DIR = path.join(__dirname, "outputs");
var JOBS_DIR = path.join(__dirname, "jobs");

[OUTPUT_DIR, JOBS_DIR].forEach(function(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function loadJob(jobId) {
  try {
    var f = path.join(JOBS_DIR, jobId + ".json");
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) { return null; }
}

app.get("/", function(req, res) {
  res.json({ status: "kids-merger-pro split engine active", version: "9.5" });
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

  console.log("--- Merge request received on split engine architecture ---");
  if (!voiceInput || !scenesInput) {
    return res.status(400).json({ error: "Missing voice_url or scenes components", status: "failed" });
  }

  var jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  var serverUrl = process.env.RAILWAY_STATIC_URL || "kidscartoon-production.up.railway.app";
  if (serverUrl.indexOf("http") !== 0) serverUrl = "https://" + serverUrl;

  // Save base tracking configuration file
  try {
    fs.writeFileSync(path.join(JOBS_DIR, jobId + ".json"), JSON.stringify({ status: "processing", started: Date.now() }));
  } catch(e){}

  res.json({
    status: "processing",
    job_id: jobId,
    status_url: serverUrl + "/status/" + jobId
  });

  // Safe background worker call execution
  worker.processVideo(jobId, voiceInput, musicInput, scenesInput, serverUrl);
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Split architecture listening securely on port: " + PORT);
});
