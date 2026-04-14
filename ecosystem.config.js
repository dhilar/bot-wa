module.exports = {
  apps: [
    {
      name: "botwa",
      script: "index.js",
      interpreter: "node",
      interpreter_args: "--expose-gc",
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
}