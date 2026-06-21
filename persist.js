const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PASSWORD_PATH = path.join(DATA_DIR, 'admin-password.txt');

let isHF = false;
let gitInitialized = false;

function init() {
  isHF = !!process.env.SPACE_ID;
  if (!isHF) {
    console.log('Not on HF Spaces, git persistence disabled');
    return;
  }
  try {
    execSync('git config user.name "Class Memories Bot"', { cwd: APP_DIR, stdio: 'pipe' });
    execSync('git config user.email "bot@class-memories.app"', { cwd: APP_DIR, stdio: 'pipe' });
    gitInitialized = true;
    console.log('Git persistence initialized on HF Spaces');
  } catch (e) {
    console.log('Git config failed:', e.message);
  }
}

function commitAndPush(message) {
  if (!isHF || !gitInitialized) return;
  try {
    execSync('git add -A', { cwd: APP_DIR, stdio: 'pipe', timeout: 10000 });
    const status = execSync('git status --porcelain', { cwd: APP_DIR, stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
    if (!status) return;
    execSync(`git commit -m "${message.replace(/"/g, '\'')}"`, { cwd: APP_DIR, stdio: 'pipe', timeout: 10000 });
    execSync('git pull --rebase origin main 2>/dev/null; git push origin main', { cwd: APP_DIR, stdio: 'pipe', timeout: 30000 });
  } catch (e) {
    console.log('Git persist error:', e.message);
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  commitAndPush('Update config');
}

function savePassword(password) {
  fs.writeFileSync(PASSWORD_PATH, password);
  commitAndPush('Update password');
}

function deleteUpload(personId, sectionId, filename) {
  const filePath = path.join(DATA_DIR, 'uploads', personId, sectionId, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { init, saveConfig, savePassword, deleteUpload };
