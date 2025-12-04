import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGES_DIR = path.resolve(__dirname, "images");
const OUTPUT_SUBDIR = "formatted";
const OUTPUT_DIR = path.join(IMAGES_DIR, OUTPUT_SUBDIR);

const SUPPORTED_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".tif",
  ".tiff",
  ".gif",
]);

function parseArgs(argv) {
  const opts = {
    maxWidth: 1600,
    quality: 80,
    formats: ["webp", "jpeg"],
    dryRun: false,
    overwrite: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--overwrite") opts.overwrite = true;
    else if (arg.startsWith("--max-width="))
      opts.maxWidth = Number(arg.split("=")[1]) || opts.maxWidth;
    else if (arg.startsWith("--quality="))
      opts.quality = Number(arg.split("=")[1]) || opts.quality;
    else if (arg.startsWith("--formats=")) {
      const v = arg.split("=")[1];
      if (v)
        opts.formats = v
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
    }
  }
  return opts;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function isImageFile(name) {
  const ext = path.extname(name).toLowerCase();
  return SUPPORTED_EXTS.has(ext);
}

async function listImageFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === OUTPUT_SUBDIR) continue;
      // Skip subdirectories for simplicity; could be extended to recurse
      continue;
    }
    if (e.isFile() && isImageFile(e.name)) files.push(path.join(dir, e.name));
  }
  return files;
}

async function processImage(srcPath, opts) {
  const basename = path.basename(srcPath);
  const nameNoExt = path.basename(srcPath, path.extname(srcPath));

  const pipeline = sharp(srcPath, { failOn: "none" }).rotate();

  // Read metadata to optionally skip resize if already smaller
  const meta = await pipeline.metadata();
  const shouldResize =
    typeof meta.width === "number" && meta.width > opts.maxWidth;

  let work = pipeline;
  if (shouldResize) {
    work = work.resize({
      width: opts.maxWidth,
      withoutEnlargement: true,
      fit: "inside",
    });
  }

  const outputs = [];
  for (const fmt of opts.formats) {
    if (fmt === "webp") {
      const outFile = path.join(OUTPUT_DIR, `${nameNoExt}.webp`);
      outputs.push({
        fmt,
        outFile,
        fn: (img) => img.webp({ quality: opts.quality, effort: 4 }),
      });
    } else if (fmt === "jpeg" || fmt === "jpg") {
      const outFile = path.join(OUTPUT_DIR, `${nameNoExt}.jpg`);
      outputs.push({
        fmt: "jpeg",
        outFile,
        fn: (img) => img.jpeg({ quality: opts.quality, mozjpeg: true }),
      });
    } else if (fmt === "png") {
      const outFile = path.join(OUTPUT_DIR, `${nameNoExt}.png`);
      outputs.push({
        fmt,
        outFile,
        fn: (img) => img.png({ quality: opts.quality }),
      });
    } else {
      console.warn(`Skipping unsupported output format: ${fmt}`);
    }
  }

  const results = [];
  for (const { outFile, fn, fmt } of outputs) {
    if (!opts.overwrite) {
      try {
        await fs.access(outFile);
        // exists
        results.push({
          src: basename,
          out: path.basename(outFile),
          fmt,
          status: "skipped-exists",
        });
        continue;
      } catch {}
    }
    if (opts.dryRun) {
      results.push({
        src: basename,
        out: path.basename(outFile),
        fmt,
        status: "dry-run",
      });
      continue;
    }
    const img = fn(work.clone());
    await img.toFile(outFile);
    results.push({
      src: basename,
      out: path.basename(outFile),
      fmt,
      status: "written",
    });
  }

  return results;
}

async function main() {
  const opts = parseArgs(process.argv);

  try {
    await fs.access(IMAGES_DIR);
  } catch {
    console.error(`Missing images directory: ${IMAGES_DIR}`);
    process.exit(1);
  }

  await ensureDir(OUTPUT_DIR);

  const files = await listImageFiles(IMAGES_DIR);
  if (files.length === 0) {
    console.log("No images found to process.");
    return;
  }

  console.log(`Found ${files.length} image(s). Output -> ${OUTPUT_DIR}`);
  if (opts.dryRun) console.log("(dry-run) No files will be written");

  const allResults = [];
  for (const f of files) {
    try {
      const res = await processImage(f, opts);
      allResults.push(...res);
    } catch (err) {
      console.error(
        `Error processing ${path.basename(f)}:`,
        err?.message || err
      );
    }
  }

  const written = allResults.filter((r) => r.status === "written").length;
  const skipped = allResults.filter(
    (r) => r.status === "skipped-exists"
  ).length;
  const dry = allResults.filter((r) => r.status === "dry-run").length;

  for (const r of allResults) {
    console.log(`${r.status.padEnd(13)} ${r.src} -> ${r.out} [${r.fmt}]`);
  }

  console.log(`Done. written=${written}, skipped=${skipped}, dry=${dry}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
