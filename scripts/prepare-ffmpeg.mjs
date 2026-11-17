import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bulkBuild = "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases";
const bulkTag = "autobuild-2026-10-31-12-59";
const macBuild = "https://github.com/dfloresc/ffmpeg-macos-builds/releases";
const macTag = "v9.0.1-1";

const artifacts = {
  "win32-x64": {
    release: `${bulkBuild}/tag/${bulkTag}`,
    download: `${bulkBuild}/download/${bulkTag}`,
    name: "ffmpeg-n9.0.2-39-g7adfbe40dc-win64-lgpl-shared-9.0.zip",
    sha256: "e907b01fa4783913151237e37df2a10fa97d99a1598a021bf59d4ae62ffed4c0",
  },
  "linux-x64": {
    release: `${bulkBuild}/tag/${bulkTag}`,
    download: `${bulkBuild}/download/${bulkTag}`,
    name: "ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-lgpl-shared-9.0.tar.xz",
    sha256: "5a58e2dffad4835ee3418939f2676d6898489f8e047299f5f62ee0da3f8dd5dc",
  },
  "darwin-arm64": {
    release: `${macBuild}/tag/${macTag}`,
    download: `${macBuild}/download/${macTag}`,
    name: "ffmpeg-9.0.1-1-lgpl-macos-arm64.tar.xz",
    sha256: "d0ea5ea43a5adfa5d01d4137c9e5a61728b800a812f12917a26fd7af0c14c03a",
  },
};

const platform = process.platform;
const artifact = artifacts[`${platform}-${process.arch}`];
if (!artifact) {
  throw new Error(`No bundled FFmpeg build for ${platform}-${process.arch}.`);
}

const tauri = fileURLToPath(new URL("../src-tauri/", import.meta.url));
const cache = join(tauri, "target", "ffmpeg-downloads");
const destination = join(tauri, "media-tools", "ffmpeg", "dist");
const archive = join(cache, artifact.name);
const downloadUrl = `${artifact.download}/${artifact.name}`;

function run(program, args, capture = false) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${program} exited with ${result.status ?? result.signal}.`,
    );
  }
  return result.stdout;
}

async function checksum(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "prepare-"));
try {
  if (!existsSync(archive) || (await checksum(archive)) !== artifact.sha256) {
    const download = join(work, artifact.name);
    run(platform === "win32" ? "curl.exe" : "curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "2",
      "--retry-all-errors",
      "--connect-timeout",
      "15",
      "--max-time",
      "300",
      "--output",
      download,
      downloadUrl,
    ]);
    if ((await checksum(download)) !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch for ${artifact.name}.`);
    }
    renameSync(download, archive);
  }

  const unpacked = join(work, "unpacked");
  const stage = join(work, "dist");
  const bin = join(stage, "bin");
  mkdirSync(unpacked);
  mkdirSync(bin, { recursive: true });
  run(platform === "win32" ? "tar.exe" : "tar", [
    "-xf",
    archive,
    "-C",
    unpacked,
  ]);
  const root = join(unpacked, artifact.name.replace(/\.(?:tar\.xz|zip)$/, ""));

  const suffix = platform === "win32" ? ".exe" : "";
  const ffmpeg = join(bin, `ffmpeg${suffix}`);
  const ffprobe = join(bin, `ffprobe${suffix}`);
  copyFileSync(join(root, "bin", `ffmpeg${suffix}`), ffmpeg);
  copyFileSync(join(root, "bin", `ffprobe${suffix}`), ffprobe);

  if (platform === "win32") {
    for (const name of readdirSync(join(root, "bin"))) {
      if (name.endsWith(".dll"))
        copyFileSync(join(root, "bin", name), join(bin, name));
    }
  } else {
    const libraryDir = join(root, "lib");
    const libraries = join(stage, "lib");
    // Package the sonames the executables load, without duplicating each dylib or .so under all its aliases.
    const soname = platform === "darwin" ? /^[^.]+\.\d+\.dylib$/ : /\.so\.\d+$/;
    mkdirSync(libraries);
    for (const name of readdirSync(libraryDir)) {
      if (soname.test(name))
        copyFileSync(join(libraryDir, name), join(libraries, name));
    }
  }

  if (platform === "darwin") {
    cpSync(join(root, "LICENSES"), join(stage, "LICENSES"), {
      recursive: true,
    });
    copyFileSync(join(root, "BUILDINFO.txt"), join(stage, "BUILDINFO.txt"));
  } else {
    copyFileSync(join(root, "LICENSE.txt"), join(stage, "LICENSE.txt"));
  }
  writeFileSync(
    join(stage, "SOURCE.txt"),
    [
      artifact.name,
      `Binary archive: ${downloadUrl}`,
      `SHA-256: ${artifact.sha256}`,
      `Release and source information: ${artifact.release}`,
      ...(platform === "darwin"
        ? []
        : [
            "FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/7adfbe40dcde598f93a6963d2f7b22cd75202ccc",
            "Build scripts and dependency source revisions: https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/5031c6f1082414e53688d39e521849905071070d",
          ]),
      "",
    ].join("\n"),
  );

  const encoders = run(ffmpeg, ["-hide_banner", "-encoders"], true);
  const muxers = run(ffmpeg, ["-hide_banner", "-muxers"], true);
  if (!/\blibmp3lame\b/.test(encoders) || !/^\s*E\s+segment\s/m.test(muxers)) {
    throw new Error(
      "Bundled FFmpeg must support libmp3lame encoding and the segment muxer.",
    );
  }
  run(ffprobe, ["-version"], true);

  const previous = join(work, "previous-dist");
  if (existsSync(destination)) {
    if (!lstatSync(destination).isDirectory()) {
      throw new Error(
        `Expected a generated FFmpeg directory at ${destination}.`,
      );
    }
    renameSync(destination, previous);
  }
  try {
    renameSync(stage, destination);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, destination);
    throw error;
  }
  console.log(`Prepared prebuilt FFmpeg: ${artifact.name}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
