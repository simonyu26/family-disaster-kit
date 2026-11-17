/**
 * 防災小隊・每日自動備份（進度表 #35）
 *
 * 放在「獨立」的 Apps Script 專案（例如「防災小隊備份」），不要和 gas/Code.gs 放在同一個專案：
 * Apps Script 的權限是整個專案共用，放在一起會讓公開的 Web App 也拿到整個雲端硬碟的讀寫權（工程顧問諮詢，必改）。
 * 本專案不部署成網頁應用程式，只靠時間觸發器執行。
 *
 * 每天 03:00（台北）做三件事，各自記錄結果，一件失敗不影響其他件：
 *   1. 複製家庭資料試算表
 *   2. 下載 GitHub repo main 分支的程式碼壓縮檔（公開 repo，只下載、不送出任何資料）
 *   3. 存一份白名單內的指令碼屬性（不含通行碼與任何金鑰）
 * 之後依保留規則清掉舊備份（移到垃圾桶，30 天內可救回）。任何一件失敗，最後都會拋出錯誤，
 * 讓 Google 依觸發器的「失敗通知」寄信給擁有者。
 *
 * 需要在本專案的指令碼屬性設定：
 *   SPREADSHEET_ID      （必填）家庭資料試算表的 ID，和 Web App 專案的同名屬性相同
 *   INVENTORY_SHEET_NAME、CHAR_HEADER_NAMES（選填）照 Web App 專案的值抄一份，備份時一併存下
 * 程式會自己寫入：
 *   BACKUP_FOLDER_ID    備份資料夾的 ID（第一次執行時建立或找到後存入）
 */

const BACKUP_PARENT_FOLDER_NAME = '防災生存整備系統_開發備份';  // W-16 既有的備份資料夾
const BACKUP_SUBFOLDER_NAME = '每日自動備份';
const BACKUP_FOLDER_ID_KEY = 'BACKUP_FOLDER_ID';
const BACKUP_PROPERTY_WHITELIST = ['SPREADSHEET_ID', 'INVENTORY_SHEET_NAME', 'CHAR_HEADER_NAMES'];
const BACKUP_REPO_ZIP_URL = 'https://github.com/simonyu26/family-disaster-kit/archive/refs/heads/main.zip';
const BACKUP_TIMEZONE = 'Asia/Taipei';
const BACKUP_DAILY_KEEP_DAYS = 14;   // 14 天內的每日備份全部保留
const BACKUP_WEEKLY_KEEP_WEEKS = 8;  // 超過 14 天的，只留 8 週內的週日那份
const BACKUP_FILE_PREFIX = '防災備份_';
const BACKUP_FILE_PATTERN = /^防災備份_(試算表|程式碼|屬性)_(\d{4})-(\d{2})-(\d{2})(\.zip|\.json)?$/;
const BACKUP_RESULT_FILE_NAME = '防災備份_上次結果.txt';

/**
 * 每日備份主程式（時間觸發器呼叫；也可在編輯器手動執行一次做上線核對）
 */
function dailyBackup() {
  const folder = getBackupFolder();
  assertFolderNotShared(folder);

  const today = Utilities.formatDate(new Date(), BACKUP_TIMEZONE, 'yyyy-MM-dd');
  const results = [];

  results.push(runBackupStep('試算表', () => backupSpreadsheet(folder, today)));
  results.push(runBackupStep('程式碼', () => backupRepoZip(folder, today)));
  results.push(runBackupStep('屬性', () => backupProperties(folder, today)));
  results.push(runBackupStep('清理舊備份', () => pruneOldBackups(folder, today)));

  writeResultFile(folder, results);

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    throw new Error('每日備份有 ' + failed.length + ' 項失敗：' + failed.map(r => r.name + '（' + r.message + '）').join('；'));
  }
}

/**
 * 建立每天 03:00（台北）的觸發器。在編輯器手動執行一次即可；重複執行不會多建。
 * 執行後請到左側「觸發條件」，把這個觸發器的「失敗通知設定」改成「立即通知我」。
 */
function setupBackupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyBackup')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyBackup')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .inTimezone(BACKUP_TIMEZONE)
    .create();
  console.log('已建立每日 03:00（台北）備份觸發器。請到「觸發條件」把失敗通知設成「立即」。');
}

function runBackupStep(name, fn) {
  try {
    const message = fn();
    console.log(name + '：' + message);
    return { name: name, ok: true, message: message };
  } catch (err) {
    console.error(name + ' 失敗：' + err.message);
    return { name: name, ok: false, message: err.message };
  }
}

/**
 * 取得備份資料夾。
 * - 已存資料夾 ID：一律用 ID 找；找不到或已在垃圾桶就停止並報錯，不另建（避免備份散到別處）。
 * - 尚未存 ID（第一次執行）：在「防災生存整備系統_開發備份」底下找或建「每日自動備份」，存下 ID。
 *   上層資料夾同名不只一個時停止，請擁有者手動在屬性填 BACKUP_FOLDER_ID。
 */
function getBackupFolder() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(BACKUP_FOLDER_ID_KEY);
  if (savedId) {
    let folder;
    try {
      folder = DriveApp.getFolderById(savedId);
    } catch (err) {
      throw new Error('找不到備份資料夾（' + BACKUP_FOLDER_ID_KEY + '）。請確認資料夾沒有被刪除，或到指令碼屬性修正 ID');
    }
    if (folder.isTrashed()) {
      throw new Error('備份資料夾在垃圾桶裡。請先從垃圾桶還原，或到指令碼屬性修正 ' + BACKUP_FOLDER_ID_KEY);
    }
    return folder;
  }

  const parents = DriveApp.getFoldersByName(BACKUP_PARENT_FOLDER_NAME);
  const parentList = [];
  while (parents.hasNext()) {
    const f = parents.next();
    if (!f.isTrashed()) parentList.push(f);
  }
  if (parentList.length > 1) {
    throw new Error('雲端硬碟裡有 ' + parentList.length + ' 個「' + BACKUP_PARENT_FOLDER_NAME + '」資料夾，無法判斷用哪一個。請在指令碼屬性手動填入 ' + BACKUP_FOLDER_ID_KEY);
  }
  const parent = parentList.length === 1 ? parentList[0] : DriveApp.createFolder(BACKUP_PARENT_FOLDER_NAME);

  const subs = parent.getFoldersByName(BACKUP_SUBFOLDER_NAME);
  const folder = subs.hasNext() ? subs.next() : parent.createFolder(BACKUP_SUBFOLDER_NAME);
  props.setProperty(BACKUP_FOLDER_ID_KEY, folder.getId());
  return folder;
}

/**
 * 備份資料夾不可分享給任何人；有分享就停止（試算表含健康資料，複本會跟著資料夾的分享設定）。
 */
function assertFolderNotShared(folder) {
  const access = folder.getSharingAccess();
  // 擁有者不算分享；以 email 排除，避免把自己誤判成「有分享」
  const owner = folder.getOwner();
  const ownerEmail = owner ? owner.getEmail() : '';
  const notOwner = u => u.getEmail() !== ownerEmail;
  const editors = folder.getEditors().filter(notOwner);
  const viewers = folder.getViewers().filter(notOwner);
  if (access !== DriveApp.Access.PRIVATE || editors.length > 0 || viewers.length > 0) {
    throw new Error('備份資料夾「' + folder.getName() + '」有分享給別人或開放連結，為保護家人資料已停止備份。請把資料夾改回只有自己能看');
  }
}

function backupSpreadsheet(folder, today) {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('尚未設定 SPREADSHEET_ID');
  const name = BACKUP_FILE_PREFIX + '試算表_' + today;
  if (hasActiveFile(folder, name)) return '今天已備份過，略過';
  DriveApp.getFileById(id).makeCopy(name, folder);
  return '已複製';
}

function backupRepoZip(folder, today) {
  const name = BACKUP_FILE_PREFIX + '程式碼_' + today + '.zip';
  if (hasActiveFile(folder, name)) return '今天已備份過，略過';
  const res = UrlFetchApp.fetch(BACKUP_REPO_ZIP_URL, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error('下載程式碼失敗，GitHub 回應狀態 ' + res.getResponseCode());
  folder.createFile(res.getBlob().setName(name));
  return '已下載';
}

function backupProperties(folder, today) {
  const name = BACKUP_FILE_PREFIX + '屬性_' + today + '.json';
  if (hasActiveFile(folder, name)) return '今天已備份過，略過';
  const props = PropertiesService.getScriptProperties();
  const saved = {};
  BACKUP_PROPERTY_WHITELIST.forEach(key => {
    const v = props.getProperty(key);
    if (v !== null) saved[key] = v;
  });
  folder.createFile(name, JSON.stringify(saved, null, 2), 'application/json');
  return '已存 ' + Object.keys(saved).length + ' 項（白名單）';
}

/**
 * 保留規則：14 天內全留；超過 14 天只留週日那份，最多 8 週；其餘移到垃圾桶。
 * 只處理檔名符合備份格式的檔，資料夾內其他檔一律不動。
 */
function pruneOldBackups(folder, today) {
  const todayDays = dayNumber(today.substring(0, 4), today.substring(5, 7), today.substring(8, 10));
  const files = folder.getFiles();
  let trashed = 0;
  while (files.hasNext()) {
    const file = files.next();
    const m = file.getName().match(BACKUP_FILE_PATTERN);
    if (!m) continue;
    if (!shouldKeepBackup(todayDays, m[2], m[3], m[4])) {
      file.setTrashed(true);
      trashed++;
    }
  }
  return trashed > 0 ? '移到垃圾桶 ' + trashed + ' 個舊檔' : '沒有要清的舊檔';
}

function shouldKeepBackup(todayDays, y, mo, d) {
  const days = dayNumber(y, mo, d);
  const age = todayDays - days;
  if (age < 0) return true;  // 未來日期（時鐘異常）不動
  if (age < BACKUP_DAILY_KEEP_DAYS) return true;
  const isSunday = new Date(days * 86400000).getUTCDay() === 0;
  return isSunday && age < BACKUP_WEEKLY_KEEP_WEEKS * 7;  // 8 週內的週日（含 14 天內那兩份）共約 8 份
}

// 以 UTC 計算的「第幾天」，只用來比較日期差，不受時區與日光節約影響
function dayNumber(y, mo, d) {
  return Math.floor(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10)) / 86400000);
}

// 資料夾內有沒有同名、而且不在垃圾桶的檔（getFilesByName 也會找到垃圾桶裡的檔）
function hasActiveFile(folder, name) {
  const it = folder.getFilesByName(name);
  while (it.hasNext()) {
    if (!it.next().isTrashed()) return true;
  }
  return false;
}

function writeResultFile(folder, results) {
  const now = Utilities.formatDate(new Date(), BACKUP_TIMEZONE, 'yyyy-MM-dd HH:mm');
  const lines = ['上次備份：' + now].concat(results.map(r => (r.ok ? '✓ ' : '✗ ') + r.name + '：' + r.message));
  try {
    const existing = folder.getFilesByName(BACKUP_RESULT_FILE_NAME);
    let target = null;
    while (existing.hasNext()) {
      const f = existing.next();
      if (!f.isTrashed()) { target = f; break; }
    }
    if (target) target.setContent(lines.join('\n'));
    else folder.createFile(BACKUP_RESULT_FILE_NAME, lines.join('\n'), 'text/plain');
  } catch (err) {
    console.error('寫入結果檔失敗：' + err.message);
  }
}
