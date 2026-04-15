const os = require("os")
const fs = require("fs")
const path = require("path")
const { formatBytes, runtime } = require("./utils")

function getSystemInfo() {
  const mem = process.memoryUsage()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(2)

  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: os.cpus()?.[0]?.model || "Unknown CPU",
    cpuCores: os.cpus()?.length || 0,
    totalMem: formatBytes(totalMem),
    usedMem: formatBytes(usedMem),
    freeMem: formatBytes(freeMem),
    memUsagePercent: `${memUsagePercent}%`,
    processRss: formatBytes(mem.rss),
    processHeapUsed: formatBytes(mem.heapUsed),
    processHeapTotal: formatBytes(mem.heapTotal),
    uptime: runtime(process.uptime()),
    nodeVersion: process.version,
    arch: os.arch(),
    loadAvg: os.loadavg().map(x => x.toFixed(2)).join(", ")
  }
}

function clearTempFiles() {
  const targets = ["tmp", "temp", ".cache"]
  let removed = []

  for (const dir of targets) {
    const full = path.join(process.cwd(), dir)
    if (fs.existsSync(full)) {
      fs.rmSync(full, { recursive: true, force: true })
      removed.push(dir)
    }
  }

  return removed
}

module.exports = {
  getSystemInfo,
  clearTempFiles
}