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
      // Safely apply the fade filter programmatically
      .videoFilters("[0:v]fade=t=out:st=" + (clipPaths.length - 1) + ":d=0.5[v]")
      .outputOptions([
        "-c:v libx264",
        "-c:a aac",
        "-pix_fmt yuv420p",
        "-map [v]",      // Correctly separate flags and maps into explicit indices
        "-map 0:a",
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
        if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
        reject(new Error("concatenateClips: " + err.message));
      })
      .run();
  });
}
