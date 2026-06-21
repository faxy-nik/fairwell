const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_DIR = __dirname;

let isHF = false;
let gitInitialized = false;
let DATA_DIR;

function init(dataRoot) {
  DATA_DIR = dataRoot || path.join(__dirname, 'data');
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
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  if (!token) {
    console.log('No HF_TOKEN set, data will not persist across restarts');
    return;
  }
  try {
    execSync('git add -A', { cwd: APP_DIR, stdio: 'pipe', timeout: 10000 });
    const status = execSync('git status --porcelain', { cwd: APP_DIR, stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
    if (!status) return;
    execSync(`git commit -m "${message.replace(/"/g, '\'')}"`, { cwd: APP_DIR, stdio: 'pipe', timeout: 10000 });
    const remote = execSync('git remote get-url origin', { cwd: APP_DIR, encoding: 'utf-8', timeout: 5000 }).trim();
    const authRemote = remote.replace('://', `://user:${token}@`);
    execSync(`git pull --rebase origin main 2>/dev/null`, { cwd: APP_DIR, stdio: 'pipe', timeout: 15000 });
    execSync(`git push ${authRemote} main`, { cwd: APP_DIR, stdio: 'pipe', timeout: 30000 });
  } catch (e) {
    console.log('Git persist error:', e.message);
  }
}

function saveConfig(config) {
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
  commitAndPush('Update config');
}

function savePassword(password) {
  fs.writeFileSync(path.join(DATA_DIR, 'admin-password.txt'), password);
  commitAndPush('Update password');
}

function deleteUpload(personId, sectionId, filename) {
  const filePath = path.join(DATA_DIR, 'uploads', personId, sectionId, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { init, saveConfig, savePassword, deleteUpload };
