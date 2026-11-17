/**
 * 家庭防災整備系統 GAS 後端
 *
 * 部署前須在「專案設定 ＞ 指令碼屬性」設定：
 *   SPREADSHEET_ID      （必填）家庭試算表 ID，即試算表網址 /d/ 與 /edit 之間那一段
 *   INVENTORY_SHEET_NAME（建議）物資分頁名稱，例如「目前物資」；設定後只讀寫這一頁，找不到就停止同步
 *   CHAR_HEADER_NAMES   （選填）物資表「角色列」上的任兩個成員名稱，以半形逗號分隔，用來找出角色列
 *   FAMILY_PIN          （必填）家庭通行碼，至少 6 碼；未設定時除公開情資外一律拒絕存取
 *   GEMINI_API_KEY      （選填）拍標籤辨識用
 * 公開 repo 不放試算表 ID、真實人名與金鑰（S-08），一律由指令碼屬性讀取。
 */

/**
 * 開啟家庭試算表（ID 由指令碼屬性 SPREADSHEET_ID 讀取）
 */
function openFamilySpreadsheet() {
  const id = (PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '').trim();
  if (!id) {
    throw new Error('後端尚未設定家庭試算表，請管理者到 GAS「專案設定 ＞ 指令碼屬性」新增 SPREADSHEET_ID');
  }
  return SpreadsheetApp.openById(id);
}

const PIN_MIN_LENGTH = 6;
const PIN_MAX_FAILURES = 5;            // 10 分鐘內猜錯 5 次就鎖定
const PIN_FAILURE_WINDOW_SEC = 600;
const PIN_LOCK_SEC = 900;              // 鎖定 15 分鐘
const PIN_FAIL_COUNT_KEY = 'pinFailCount';
const PIN_LOCKED_KEY = 'pinLocked';

/**
 * 檢查家庭通行碼（fail-closed）
 * - 未設定 FAMILY_PIN：一律拒絕（pinNotSet），由管理者在 GAS 指令碼屬性手動設定
 * - 猜錯次數過多：暫時鎖定（locked），鎖定期間正確通行碼也不接受
 * GAS 取不到來源 IP，因此失敗次數為全專案共用計數。
 */
function checkAuthPin(providedPin) {
  const savedPin = PropertiesService.getScriptProperties().getProperty('FAMILY_PIN') || '';
  if (!savedPin) return { ok: false, pinNotSet: true };

  const cache = CacheService.getScriptCache();
  if (cache.get(PIN_LOCKED_KEY)) return { ok: false, locked: true };

  if (String(providedPin || '').trim() === savedPin) {
    cache.remove(PIN_FAIL_COUNT_KEY);
    return { ok: true, pinRequired: true };
  }

  const fails = parseInt(cache.get(PIN_FAIL_COUNT_KEY) || '0', 10) + 1;
  if (fails >= PIN_MAX_FAILURES) {
    cache.put(PIN_LOCKED_KEY, '1', PIN_LOCK_SEC);
    cache.remove(PIN_FAIL_COUNT_KEY);
    return { ok: false, locked: true };
  }
  cache.put(PIN_FAIL_COUNT_KEY, String(fails), PIN_FAILURE_WINDOW_SEC);
  return { ok: false, pinRequired: true };
}

/**
 * 通行碼驗證失敗時回傳給前端的白話訊息（U-03）
 * 未設定與鎖定時不帶 authRequired，避免前端反覆跳出輸入框。
 */
function authFailureOutput(auth, wrongPinMessage) {
  if (auth.pinNotSet) {
    return createJsonOutput({ ok: false, pinNotSet: true, error: '雲端尚未設定家庭通行碼，暫時無法同步。請管理者到 GAS「專案設定 ＞ 指令碼屬性」新增 FAMILY_PIN（至少 ' + PIN_MIN_LENGTH + ' 碼）' });
  }
  if (auth.locked) {
    return createJsonOutput({ ok: false, locked: true, error: '通行碼錯誤次數過多，雲端同步已暫停 ' + Math.round(PIN_LOCK_SEC / 60) + ' 分鐘。本機資料仍可使用，請稍後再試' });
  }
  return createJsonOutput({ ok: false, authRequired: true, error: wrongPinMessage });
}

const READ_ACTIONS = ['getAll', 'getLocations', 'getContacts'];
const READ_PIN_ERROR = '請輸入正確的家庭通行碼以同步雲端資料';

/**
 * 讀取家庭資料（GET 與 POST 共用；呼叫前須已通過通行碼驗證）
 */
function readFamilyData(action, auth) {
  if (action === 'getLocations') {
    return { ok: true, pinRequired: auth.pinRequired, locations: getLocationsData(), serverTime: new Date().toISOString() };
  }
  if (action === 'getContacts') {
    return { ok: true, pinRequired: auth.pinRequired, contacts: getContactsData(), serverTime: new Date().toISOString() };
  }
  const inv = getInventoryData();
  return {
    ok: true,
    pinRequired: auth.pinRequired,
    inventory: inv,
    members: getMembersData(inv.characters),
    locations: getLocationsData(),
    contacts: getContactsData(),
    serverTime: new Date().toISOString()
  };
}

/**
 * 處理外部 PWA 的 GET 請求
 * 過渡期：仍接受以網址參數 pin 讀取家庭資料，等前端改用 POST 上線後即移除（S-04、E-12）。
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action ? params.action : 'getAll';

    // 公開防災情資代理（NCDR 與 AED 不涉及試算表個資，免通行碼即可查詢）
    if (action === 'getAlerts') {
      return createJsonOutput(getDisasterAlerts());
    }
    if (action === 'getAeds') {
      const lat = parseFloat(params.lat || '25.0330');
      const lng = parseFloat(params.lng || '121.5430');
      return createJsonOutput(getNearbyAeds(lat, lng));
    }

    // 驗證家庭通行碼（過渡期 GET 讀取）
    const auth = checkAuthPin(params.pin);
    if (!auth.ok) {
      return authFailureOutput(auth, READ_PIN_ERROR);
    }
    return createJsonOutput(readFamilyData(action, auth));
  } catch (err) {
    return createJsonOutput({ ok: false, error: err.message });
  }
}

/**
 * 處理外部 PWA 的 POST 請求（前端以 Content-Type: text/plain 傳送 JSON 避免 CORS Preflight）
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;

    // 更新家庭通行碼：只接受「已知舊碼換新碼」；首次設定須由管理者在 GAS 指令碼屬性手動填入，
    // 也不接受換成空值（不可經 API 解除保護）
    if (action === 'setFamilyPin') {
      const pinAuth = checkAuthPin(payload.oldPin);
      if (!pinAuth.ok) {
        return authFailureOutput(pinAuth, '原家庭通行碼不正確，無法變更');
      }
      const newPin = String(payload.newPin || '').trim();
      if (newPin.length < PIN_MIN_LENGTH) {
        return createJsonOutput({ ok: false, error: '新的家庭通行碼至少要 ' + PIN_MIN_LENGTH + ' 碼，請重新輸入' });
      }
      PropertiesService.getScriptProperties().setProperty('FAMILY_PIN', newPin);
      return createJsonOutput({ ok: true, pinRequired: true, serverTime: new Date().toISOString() });
    }

    // 讀取家庭資料：通行碼放在 POST 本文，不放網址（S-04）
    if (READ_ACTIONS.includes(action)) {
      const readAuth = checkAuthPin(payload.pin);
      if (!readAuth.ok) {
        return authFailureOutput(readAuth, READ_PIN_ERROR);
      }
      return createJsonOutput(readFamilyData(action, readAuth));
    }

    // 驗證家庭通行碼
    const auth = checkAuthPin(payload.pin);
    if (!auth.ok) {
      return authFailureOutput(auth, '家庭通行碼驗證失敗，無法寫入雲端');
    }

    if (action === 'updateItem') {
      updateItemData(payload.row, payload.charName, payload.state, payload.expDate, payload.qty, payload.textNote, payload.spec);
      return createJsonOutput({ ok: true, serverTime: new Date().toISOString() });
    }

    if (action === 'batchSync') {
      const actions = payload.actions || [];
      // 先確認物資頁存在；找不到就整批不寫，避免地點、聯絡人先寫入後重送時重複新增
      getTargetSheet(openFamilySpreadsheet());
      actions.forEach(act => {
        if (act.action === 'updateItem') {
          updateItemData(act.row, act.charName, act.state, act.expDate, act.qty, act.textNote, act.spec);
        } else if (act.action === 'addItem') {
          addNewItem(act.category, act.itemName, act.requiredChars || []);
        } else if (act.action === 'addLocation') {
          addLocationRecord(act.location);
        } else if (act.action === 'deleteLocation') {
          deleteLocationRecord(act.id);
        } else if (act.action === 'addContact') {
          addContactRecord(act.contact);
        } else if (act.action === 'updateContact') {
          updateContactRecord(act.contact);
        } else if (act.action === 'deleteContact') {
          deleteContactRecord(act.id);
        }
      });
      const inv = getInventoryData();
      return createJsonOutput({
        ok: true,
        pinRequired: auth.pinRequired,
        inventory: inv,
        members: getMembersData(inv.characters),
        locations: getLocationsData(),
        contacts: getContactsData(),
        serverTime: new Date().toISOString()
      });
    }

    if (action === 'addItem') {
      addNewItem(payload.category, payload.itemName, payload.requiredChars || []);
      return createJsonOutput({ ok: true, inventory: getInventoryData(), serverTime: new Date().toISOString() });
    }

    if (action === 'editItem') {
      editExistingItem(payload.row, payload.newName, payload.newCategory);
      return createJsonOutput({ ok: true, inventory: getInventoryData(), serverTime: new Date().toISOString() });
    }

    if (action === 'deleteItem') {
      deleteExistingItem(payload.row);
      return createJsonOutput({ ok: true, inventory: getInventoryData(), serverTime: new Date().toISOString() });
    }

    // 成員管理 API（支援 10 欄：改名、頭像、血型、醫療、成員類型、行動能力、急救技能）
    if (action === 'addMember') {
      addMemberRecord(
        payload.name, payload.avatar, payload.buddy, payload.defaultState || '-',
        payload.blood, payload.medical, payload.iceContact, payload.rallyNote,
        payload.memberType, payload.mobility, payload.firstAidSkill
      );
      const inv = getInventoryData();
      return createJsonOutput({
        ok: true,
        inventory: inv,
        members: getMembersData(inv.characters),
        serverTime: new Date().toISOString()
      });
    }

    if (action === 'updateMember') {
      const oldName = payload.oldName || payload.name;
      const newName = payload.newName || payload.name;
      updateMemberRecord(
        oldName, newName, payload.avatar, payload.buddy,
        payload.blood, payload.medical, payload.iceContact, payload.rallyNote,
        payload.memberType, payload.mobility, payload.firstAidSkill
      );
      const inv = getInventoryData();
      return createJsonOutput({
        ok: true,
        inventory: inv,
        members: getMembersData(inv.characters),
        serverTime: new Date().toISOString()
      });
    }

    if (action === 'deleteMember') {
      deleteMemberRecord(payload.name);
      const inv = getInventoryData();
      return createJsonOutput({
        ok: true,
        inventory: inv,
        members: getMembersData(inv.characters),
        serverTime: new Date().toISOString()
      });
    }

    // 地點與集合點管理 API
    if (action === 'addLocation') {
      addLocationRecord(payload.location);
      return createJsonOutput({ ok: true, locations: getLocationsData(), serverTime: new Date().toISOString() });
    }

    if (action === 'deleteLocation') {
      deleteLocationRecord(payload.id);
      return createJsonOutput({ ok: true, locations: getLocationsData(), serverTime: new Date().toISOString() });
    }

    // 家庭緊急聯絡網管理 API
    if (action === 'addContact') {
      addContactRecord(payload.contact);
      return createJsonOutput({ ok: true, contacts: getContactsData(), serverTime: new Date().toISOString() });
    }

    if (action === 'updateContact') {
      updateContactRecord(payload.contact);
      return createJsonOutput({ ok: true, contacts: getContactsData(), serverTime: new Date().toISOString() });
    }

    if (action === 'deleteContact') {
      deleteContactRecord(payload.id);
      return createJsonOutput({ ok: true, contacts: getContactsData(), serverTime: new Date().toISOString() });
    }

    if (action === 'setGeminiKey') {
      const cleanKey = String(payload.apiKey || '').trim();
      if (cleanKey) PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', cleanKey);
      return createJsonOutput({ ok: true, hasGeminiKey: !!cleanKey, serverTime: new Date().toISOString() });
    }

    if (action === 'recognizeLabel') {
      return createJsonOutput(recognizeItemLabelByGemini(payload.imageBase64, payload.itemName || ''));
    }

    return createJsonOutput({ ok: false, error: '未知的操作類型：' + action });
  } catch (err) {
    return createJsonOutput({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function createJsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 取得物資分頁
 * - 有設 INVENTORY_SHEET_NAME：只用這個名稱的分頁；找不到就停止同步（不退回第一頁，避免寫進封存的年度頁，D-01）
 * - 沒設：沿用舊規則（排除固定分頁後的第一個分頁），讓部署與分頁改名不必同時進行
 */
function getTargetSheet(ss) {
  const sheetName = (PropertiesService.getScriptProperties().getProperty('INVENTORY_SHEET_NAME') || '').trim();
  if (sheetName) {
    if (['Leadsheet', 'Locations', 'Members', 'Contacts'].includes(sheetName)) {
      throw new Error('INVENTORY_SHEET_NAME 不可設為「' + sheetName + '」（這是成員、聯絡人或地點用的分頁）。請改成物資分頁的名稱，例如「目前物資」');
    }
    const named = ss.getSheetByName(sheetName);
    if (!named) {
      throw new Error('找不到「' + sheetName + '」分頁，已暫停同步以免寫錯頁。請確認試算表的分頁名稱，或到 GAS 指令碼屬性修改 INVENTORY_SHEET_NAME');
    }
    return named;
  }
  const excluded = ['Leadsheet', 'Locations', 'Members', 'Contacts'];
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (!excluded.includes(sheets[i].getName())) return sheets[i];
  }
  return sheets[0];
}

function findCharRowIndex(data) {
  // 角色列辨識用的成員名稱由指令碼屬性 CHAR_HEADER_NAMES 提供（不在程式中寫死真實姓名）
  const headerNames = (PropertiesService.getScriptProperties().getProperty('CHAR_HEADER_NAMES') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (headerNames.length > 0) {
    for (let r = 0; r < Math.min(3, data.length); r++) {
      if (data[r] && headerNames.some(n => data[r].includes(n))) {
        return r;
      }
    }
  }
  for (let r = 0; r < Math.min(3, data.length); r++) {
    if (data[r] && data[r].length > 2 && data[r][2]) {
      return r;
    }
  }
  return 0;
}

function getInventoryData() {
  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);

  const range = targetSheet.getDataRange();
  const data = range.getValues();
  const notes = range.getNotes();

  const charRowIndex = findCharRowIndex(data);

  const characters = [];
  for (let i = 2; i < data[charRowIndex].length; i++) {
    const colHeader = data[charRowIndex][i];
    if (colHeader && String(colHeader).trim() !== '' && colHeader !== '確認日期') {
      characters.push({ name: String(colHeader).trim(), colIndex: i });
    }
  }

  const items = [];
  let currentCategory = '未分類';

  for (let i = charRowIndex + 1; i < data.length; i++) {
    if (!data[i]) continue;
    const itemName = data[i][1];
    if (!itemName || itemName === '確認日期' || itemName === '背包狀態確認' || itemName === '背包減重') continue;

    let isCategory = true;
    for (let c of characters) {
      if (data[i][c.colIndex] !== '' && data[i][c.colIndex] !== undefined) {
        isCategory = false;
        break;
      }
    }

    if (isCategory) {
      currentCategory = String(itemName).trim();
    } else {
      let statusObj = {};
      characters.forEach(c => {
        let val = data[i][c.colIndex];
        let rawNote = (notes[i] && notes[i][c.colIndex]) ? notes[i][c.colIndex] : '';
        let exp = '', textNote = '', spec = '', updatedAt = '';
        if (rawNote) {
          let lines = rawNote.split('\n');
          lines.forEach(line => {
            if (line.startsWith('Date:')) exp = line.substring(5).trim();
            else if (line.startsWith('Spec:')) spec = line.substring(5).trim();
            else if (line.startsWith('Updated:')) updatedAt = line.substring(8).trim();
            else if (line.startsWith('Note:')) textNote = line.substring(5).trim();
            else if (!exp && !spec && !updatedAt) textNote += (textNote ? '\n' : '') + line;
          });
          if (!exp && rawNote.match(/^\d{4}-\d{2}-\d{2}$/)) {
            exp = rawNote.trim();
            textNote = '';
          }
        }

        let state = 'missing';
        let qtyText = '';

        if (val !== '' && val !== undefined) {
          let vStr = String(val).toLowerCase().trim();
          if (vStr === 'x' || vStr === 'ｘ') state = 'missing';
          else if (vStr === '-' || vStr === 'na' || vStr === '無') state = 'na';
          else {
            state = 'ready';
            if (vStr !== 'v' && vStr !== 'ｖ' && vStr !== 'ok') qtyText = String(val).trim();
          }
        }

        statusObj[c.name] = { state: state, exp: exp, qty: qtyText, note: textNote, spec: spec, updatedAt: updatedAt };
      });
      items.push({ row: i + 1, category: currentCategory, name: String(itemName).trim(), status: statusObj });
    }
  }
  return { sheetName: targetSheet.getName(), characters: characters.map(c => c.name), items: items };
}

function updateItemData(row, charName, state, expDate, qty, textNote, spec) {
  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  const colIndex = data[charRowIndex].map(v => String(v).trim()).indexOf(charName) + 1;
  if (colIndex > 0) {
    const cell = targetSheet.getRange(row, colIndex);

    if (state === 'ready') cell.setValue((qty && String(qty).trim() !== '') ? String(qty).trim() : 'v');
    else if (state === 'missing') cell.setValue('x');
    else if (state === 'na') cell.setValue('-');

    const nowStamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
    let noteParts = [];
    if (expDate && String(expDate).trim() !== '') noteParts.push('Date: ' + String(expDate).trim());
    if (spec && String(spec).trim() !== '') noteParts.push('Spec: ' + String(spec).trim());
    if (textNote && String(textNote).trim() !== '') noteParts.push('Note: ' + String(textNote).trim());
    noteParts.push('Updated: ' + nowStamp);

    cell.setNote(noteParts.join('\n'));
  }
  return true;
}

function addNewItem(category, itemName, requiredChars) {
  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  const allChars = [];
  for (let i = 2; i < data[charRowIndex].length; i++) {
    if (data[charRowIndex][i] && data[charRowIndex][i] !== '確認日期') {
      allChars.push({ name: String(data[charRowIndex][i]).trim(), col: i + 1, colIndex: i });
    }
  }

  const cleanCat = (category || '未分類').trim();
  const cleanName = itemName.trim();

  let insertAfterRow = -1;
  let inTargetCat = false;

  for (let i = charRowIndex + 1; i < data.length; i++) {
    const cellName = data[i][1] ? String(data[i][1]).trim() : '';
    if (!cellName || cellName === '確認日期' || cellName === '背包狀態確認' || cellName === '背包減重') continue;

    let isCatRow = true;
    for (let c of allChars) {
      if (data[i][c.colIndex] !== '' && data[i][c.colIndex] !== undefined) {
        isCatRow = false;
        break;
      }
    }

    if (isCatRow) {
      if (inTargetCat) {
        insertAfterRow = i;
        break;
      }
      if (cellName === cleanCat) {
        inTargetCat = true;
        insertAfterRow = i + 1;
      }
    } else if (inTargetCat) {
      insertAfterRow = i + 1;
    }
  }

  let newItemRow;
  if (inTargetCat && insertAfterRow > 0) {
    targetSheet.insertRowAfter(insertAfterRow);
    newItemRow = insertAfterRow + 1;
  } else {
    const lastRow = targetSheet.getLastRow();
    targetSheet.getRange(lastRow + 1, 2).setValue(cleanCat);
    newItemRow = lastRow + 2;
  }

  targetSheet.getRange(newItemRow, 2).setValue(cleanName);
  allChars.forEach(c => {
    const stateVal = requiredChars.includes(c.name) ? 'x' : '-';
    targetSheet.getRange(newItemRow, c.col).setValue(stateVal);
  });
  return true;
}

function editExistingItem(row, newName, newCategory) {
  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  if (row <= charRowIndex + 1 || row > targetSheet.getLastRow()) {
    throw new Error('無效的物資列號');
  }

  const cleanNewName = (newName || '').trim();
  if (!cleanNewName) throw new Error('物資名稱不可為空');

  const allChars = [];
  for (let i = 2; i < data[charRowIndex].length; i++) {
    if (data[charRowIndex][i] && data[charRowIndex][i] !== '確認日期') {
      allChars.push({ name: String(data[charRowIndex][i]).trim(), col: i + 1, colIndex: i });
    }
  }

  let currentCat = '未分類';
  for (let i = charRowIndex + 1; i < row - 1; i++) {
    const cellName = data[i][1] ? String(data[i][1]).trim() : '';
    if (!cellName) continue;
    let isCatRow = true;
    for (let c of allChars) {
      if (data[i][c.colIndex] !== '' && data[i][c.colIndex] !== undefined) {
        isCatRow = false;
        break;
      }
    }
    if (isCatRow) currentCat = cellName;
  }

  const cleanNewCat = (newCategory || currentCat).trim();
  targetSheet.getRange(row, 2).setValue(cleanNewName);

  if (cleanNewCat === currentCat) return true;

  const maxCol = targetSheet.getLastColumn();
  const rowRange = targetSheet.getRange(row, 1, 1, maxCol);
  const rowValues = rowRange.getValues()[0];
  const rowNotes = rowRange.getNotes()[0];

  targetSheet.deleteRow(row);

  const updatedData = targetSheet.getDataRange().getValues();
  let insertAfterRow = -1;
  let inTargetCat = false;

  for (let i = charRowIndex + 1; i < updatedData.length; i++) {
    const cellName = updatedData[i][1] ? String(updatedData[i][1]).trim() : '';
    if (!cellName || cellName === '確認日期' || cellName === '背包狀態確認' || cellName === '背包減重') continue;

    let isCatRow = true;
    for (let c of allChars) {
      if (updatedData[i][c.colIndex] !== '' && updatedData[i][c.colIndex] !== undefined) {
        isCatRow = false;
        break;
      }
    }

    if (isCatRow) {
      if (inTargetCat) {
        insertAfterRow = i;
        break;
      }
      if (cellName === cleanNewCat) {
        inTargetCat = true;
        insertAfterRow = i + 1;
      }
    } else if (inTargetCat) {
      insertAfterRow = i + 1;
    }
  }

  let targetRow;
  if (inTargetCat && insertAfterRow > 0) {
    targetSheet.insertRowAfter(insertAfterRow);
    targetRow = insertAfterRow + 1;
  } else {
    const lastRow = targetSheet.getLastRow();
    targetSheet.getRange(lastRow + 1, 2).setValue(cleanNewCat);
    targetRow = lastRow + 2;
  }

  rowValues[1] = cleanNewName;
  const newRange = targetSheet.getRange(targetRow, 1, 1, maxCol);
  newRange.setValues([rowValues]);
  newRange.setNotes([rowNotes]);
  return true;
}

function deleteExistingItem(row) {
  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  if (row <= charRowIndex + 1 || row > targetSheet.getLastRow()) {
    throw new Error('無效的物資列號，無法刪除');
  }
  targetSheet.deleteRow(row);
  return true;
}

/**
 * 成員設定與家庭防災卡資料庫 (Members 工作表，擴充至 10 欄：
 * 名稱、頭像、夥伴動物、血型、過敏與用藥、緊急聯絡人、特殊醫療備註、成員類型、行動能力、急救技能)
 */
function getMembersSheet(ss, initialCharacters) {
  let sheet = ss.getSheetByName('Members');
  const headers = ['名稱', '頭像', '夥伴動物', '血型', '過敏與用藥', '緊急聯絡人', '特殊醫療備註', '成員類型', '行動能力', '急救技能'];
  // 只保留非個人的預設值；成員頭像與夥伴改由使用者在介面中設定
  const defaultMap = {
    '家庭儲備': { avatar: '⛺', buddy: '🐻', type: 'pack' }
  };

  if (!sheet) {
    sheet = ss.insertSheet('Members');
    sheet.getRange(1, 1, 1, 10).setValues([headers]);
    sheet.setFrozenRows(1);
    if (initialCharacters && initialCharacters.length > 0) {
      const rows = initialCharacters.map(name => {
        const def = defaultMap[name] || { avatar: '🧑', buddy: '🐾', type: (name.endsWith('+') || name === '家庭儲備') ? 'pack' : 'main' };
        return [name, def.avatar, def.buddy, '', '', '', '', def.type, 'self', ''];
      });
      sheet.getRange(2, 1, rows.length, 10).setValues(rows);
    }
  } else if (sheet.getLastColumn() < 10) {
    sheet.getRange(1, 1, 1, 10).setValues([headers]);
  }
  return sheet;
}

function getMembersData(initialCharacters) {
  const ss = openFamilySpreadsheet();
  const sheet = getMembersSheet(ss, initialCharacters);
  const data = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][0] || '').trim();
    if (!name) continue;
    const defaultType = (name.endsWith('+') || name === '家庭儲備') ? 'pack' : 'main';
    map[name] = {
      name: name,
      avatar: String(data[i][1] || '🧑'),
      buddy: String(data[i][2] || '🐾'),
      blood: String(data[i][3] || ''),
      medical: String(data[i][4] || ''),
      iceContact: String(data[i][5] || ''),
      rallyNote: String(data[i][6] || ''),
      memberType: String(data[i][7] || defaultType),
      mobility: String(data[i][8] || 'self'),
      firstAidSkill: String(data[i][9] || '')
    };
  }
  if (initialCharacters) {
    initialCharacters.forEach(name => {
      if (!map[name]) {
        const defaultType = (name.endsWith('+') || name === '家庭儲備') ? 'pack' : 'main';
        map[name] = {
          name: name, avatar: '🧑', buddy: '🐾', blood: '', medical: '', iceContact: '', rallyNote: '',
          memberType: defaultType, mobility: 'self', firstAidSkill: ''
        };
        sheet.appendRow([name, '🧑', '🐾', '', '', '', '', defaultType, 'self', '']);
      }
    });
  }
  return map;
}

function addMemberRecord(name, avatar, buddy, defaultState, blood, medical, iceContact, rallyNote, memberType, mobility, firstAidSkill) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('成員名稱不可為空');

  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  const existingHeaders = data[charRowIndex].map(v => String(v).trim());
  if (existingHeaders.includes(cleanName)) {
    throw new Error('成員名稱已存在：' + cleanName);
  }

  let insertCol = 3;
  for (let i = 2; i < data[charRowIndex].length; i++) {
    const h = String(data[charRowIndex][i] || '').trim();
    if (h && h !== '確認日期') insertCol = i + 2;
  }

  targetSheet.insertColumnBefore(insertCol);
  targetSheet.getRange(charRowIndex + 1, insertCol).setValue(cleanName);

  const updatedData = targetSheet.getDataRange().getValues();
  const allCharCols = [];
  for (let i = 2; i < updatedData[charRowIndex].length; i++) {
    const h = String(updatedData[charRowIndex][i] || '').trim();
    if (h && h !== '確認日期' && h !== cleanName) allCharCols.push(i);
  }

  for (let r = charRowIndex + 1; r < updatedData.length; r++) {
    const itemName = String(updatedData[r][1] || '').trim();
    if (!itemName || itemName === '確認日期' || itemName === '背包狀態確認' || itemName === '背包減重') continue;

    let isCategory = true;
    for (let colIdx of allCharCols) {
      if (updatedData[r][colIdx] !== '' && updatedData[r][colIdx] !== undefined) {
        isCategory = false;
        break;
      }
    }
    if (!isCategory) {
      targetSheet.getRange(r + 1, insertCol).setValue(defaultState);
    }
  }

  const mType = memberType || ((cleanName.endsWith('+') || cleanName === '家庭儲備') ? 'pack' : 'main');
  const mSheet = getMembersSheet(ss, []);
  mSheet.appendRow([
    cleanName, avatar || '🧑', buddy || '🐾',
    blood || '', medical || '', iceContact || '', rallyNote || '',
    mType, mobility || 'self', firstAidSkill || ''
  ]);
  return true;
}

function updateMemberRecord(oldName, newName, avatar, buddy, blood, medical, iceContact, rallyNote, memberType, mobility, firstAidSkill) {
  const cleanOld = (oldName || '').trim();
  const cleanNew = (newName || cleanOld).trim();
  if (!cleanOld || !cleanNew) throw new Error('成員名稱不可為空');

  const ss = openFamilySpreadsheet();

  if (cleanNew !== cleanOld) {
    const targetSheet = getTargetSheet(ss);
    const data = targetSheet.getDataRange().getValues();
    const charRowIndex = findCharRowIndex(data);
    const headers = data[charRowIndex].map(v => String(v).trim());
    if (headers.includes(cleanNew)) {
      throw new Error('新成員名稱已存在：' + cleanNew);
    }
    const oldCol = headers.indexOf(cleanOld) + 1;
    if (oldCol > 2) {
      targetSheet.getRange(charRowIndex + 1, oldCol).setValue(cleanNew);
    }
  }

  const sheet = getMembersSheet(ss, []);
  const mData = sheet.getDataRange().getValues();
  for (let i = 1; i < mData.length; i++) {
    if (String(mData[i][0]).trim() === cleanOld) {
      sheet.getRange(i + 1, 1).setValue(cleanNew);
      if (avatar !== undefined) sheet.getRange(i + 1, 2).setValue(avatar || '🧑');
      if (buddy !== undefined) sheet.getRange(i + 1, 3).setValue(buddy || '🐾');
      if (blood !== undefined) sheet.getRange(i + 1, 4).setValue(blood);
      if (medical !== undefined) sheet.getRange(i + 1, 5).setValue(medical);
      if (iceContact !== undefined) sheet.getRange(i + 1, 6).setValue(iceContact);
      if (rallyNote !== undefined) sheet.getRange(i + 1, 7).setValue(rallyNote);
      if (memberType !== undefined) sheet.getRange(i + 1, 8).setValue(memberType);
      if (mobility !== undefined) sheet.getRange(i + 1, 9).setValue(mobility);
      if (firstAidSkill !== undefined) sheet.getRange(i + 1, 10).setValue(firstAidSkill);
      return true;
    }
  }
  const mType = memberType || ((cleanNew.endsWith('+') || cleanNew === '家庭儲備') ? 'pack' : 'main');
  sheet.appendRow([
    cleanNew, avatar || '🧑', buddy || '🐾',
    blood || '', medical || '', iceContact || '', rallyNote || '',
    mType, mobility || 'self', firstAidSkill || ''
  ]);
  return true;
}

function deleteMemberRecord(name) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('成員名稱不可為空');

  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  const colIndex = data[charRowIndex].map(v => String(v).trim()).indexOf(cleanName) + 1;
  if (colIndex > 2) {
    targetSheet.deleteColumn(colIndex);
  }

  const mSheet = getMembersSheet(ss, []);
  const mData = mSheet.getDataRange().getValues();
  for (let i = mData.length - 1; i >= 1; i--) {
    if (String(mData[i][0]).trim() === cleanName) {
      mSheet.deleteRow(i + 1);
    }
  }
  return true;
}

/**
 * 家庭緊急聯絡網資料庫 (Contacts 工作表：ID、姓名、關係分類、關係稱謂、電話、居住地區、備註)
 */
function getContactsSheet(ss) {
  let sheet = ss.getSheetByName('Contacts');
  if (!sheet) {
    sheet = ss.insertSheet('Contacts');
    sheet.getRange(1, 1, 1, 7).setValues([['ID', '姓名', '關係分類', '關係稱謂', '電話', '居住地區', '備註']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getContactsData() {
  const ss = openFamilySpreadsheet();
  const sheet = getContactsSheet(ss);
  const data = sheet.getDataRange().getValues();
  const contacts = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0] && !data[i][1]) continue;
    contacts.push({
      id: String(data[i][0]),
      name: String(data[i][1] || ''),
      group: String(data[i][2] || 'core'),
      relation: String(data[i][3] || ''),
      phone: String(data[i][4] || ''),
      region: String(data[i][5] || ''),
      note: String(data[i][6] || '')
    });
  }
  return contacts;
}

function addContactRecord(contact) {
  if (!contact || !contact.name) throw new Error('聯絡人姓名不可為空');
  const ss = openFamilySpreadsheet();
  const sheet = getContactsSheet(ss);
  const id = contact.id || ('cnt_' + new Date().getTime());
  sheet.appendRow([
    id,
    String(contact.name).trim(),
    contact.group || 'core',
    contact.relation || '',
    contact.phone || '',
    contact.region || '',
    contact.note || ''
  ]);
  return true;
}

function updateContactRecord(contact) {
  if (!contact || !contact.id) throw new Error('無效的聯絡人編號');
  const ss = openFamilySpreadsheet();
  const sheet = getContactsSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(contact.id)) {
      sheet.getRange(i + 1, 2, 1, 6).setValues([[
        String(contact.name || '').trim(),
        contact.group || 'core',
        contact.relation || '',
        contact.phone || '',
        contact.region || '',
        contact.note || ''
      ]]);
      return true;
    }
  }
  return addContactRecord(contact);
}

function deleteContactRecord(id) {
  const ss = openFamilySpreadsheet();
  const sheet = getContactsSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

/**
 * 離線地圖避難點位與集合點階層資料庫 (Locations 工作表)
 */
function getLocationsSheet(ss) {
  let sheet = ss.getSheetByName('Locations');
  if (!sheet) {
    sheet = ss.insertSheet('Locations');
    sheet.getRange(1, 1, 1, 7).setValues([['ID', '名稱', '類型', '緯度', '經度', '備註', '建立者']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getLocationsData() {
  const ss = openFamilySpreadsheet();
  const sheet = getLocationsSheet(ss);
  const data = sheet.getDataRange().getValues();
  const locations = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0] && !data[i][1]) continue;
    locations.push({
      id: String(data[i][0]),
      name: String(data[i][1]),
      type: String(data[i][2] || '避難處所'),
      lat: Number(data[i][3]),
      lng: Number(data[i][4]),
      note: String(data[i][5] || ''),
      creator: String(data[i][6] || '')
    });
  }
  return locations;
}

function addLocationRecord(loc) {
  const ss = openFamilySpreadsheet();
  const sheet = getLocationsSheet(ss);
  const id = loc.id || ('loc_' + new Date().getTime());
  sheet.appendRow([
    id,
    loc.name,
    loc.type || '避難處所',
    Number(loc.lat),
    Number(loc.lng),
    loc.note || '',
    loc.creator || ''
  ]);
  return true;
}

function deleteLocationRecord(id) {
  const ss = openFamilySpreadsheet();
  const sheet = getLocationsSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

/**
 * 代理抓取 NCDR 民生示警公開資料平台 ATOM Feed（免金鑰），並自動標記屬於細胞廣播 (CBS) 等級之緊急告警
 */
function getDisasterAlerts() {
  const feedUrl = 'https://alerts.ncdr.nat.gov.tw/RssAtomFeed.ashx';
  const cbsRegex = /(地震|海嘯|大雷雨|颱風|土石流|大規模崩塌|水庫放流|防空|疏散避難|淹水|堰塞湖|火山|火災)/;
  try {
    const res = UrlFetchApp.fetch(feedUrl, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return { ok: false, alerts: [], error: 'NCDR 伺服器回應狀態：' + res.getResponseCode() };
    }
    const xml = XmlService.parse(res.getContentText());
    const root = xml.getRootElement();
    const ns = root.getNamespace();
    const entries = root.getChildren('entry', ns);
    const alerts = [];

    for (let i = 0; i < Math.min(entries.length, 30); i++) {
      const entry = entries[i];
      const title = (entry.getChildText('title', ns) || '').trim();
      const updated = (entry.getChildText('updated', ns) || '').trim();
      const summary = (entry.getChildText('summary', ns) || '').replace(/<[^>]+>/g, '').trim();
      const authorEl = entry.getChild('author', ns);
      const author = authorEl ? (authorEl.getChildText('name', ns) || '').trim() : '';
      const linkEl = entry.getChild('link', ns);
      const link = linkEl ? (linkEl.getAttribute('href') ? linkEl.getAttribute('href').getValue() : '') : '';
      const isCbs = cbsRegex.test(title) || cbsRegex.test(summary);

      alerts.push({
        title: title,
        updated: updated,
        summary: summary,
        author: author,
        link: link,
        isCbs: isCbs
      });
    }
    return { ok: true, alerts: alerts, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, alerts: [], error: err.message };
  }
}

/**
 * 代理抓取衛福部全國公共場所 AED 開放資料 CSV，篩選指定座標周邊最近 25 台 AED
 */
function getNearbyAeds(centerLat, centerLng) {
  const csvUrl = 'https://tw-aed.mohw.gov.tw/openData?t=csv';
  try {
    const res = UrlFetchApp.fetch(csvUrl, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return { ok: false, aeds: [], error: '衛福部 AED 資料回應狀態：' + res.getResponseCode() };
    }
    const text = res.getContentText('UTF-8');
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return { ok: false, aeds: [], error: 'AED CSV 內容為空' };

    const headers = Utilities.parseCsv(lines[0])[0];
    const nameIdx = headers.findIndex(h => h.includes('場所名稱'));
    const addrIdx = headers.findIndex(h => h.includes('場所地址') || h.includes('地址'));
    const placeIdx = headers.findIndex(h => h.includes('放置地點'));
    const latIdx = headers.findIndex(h => h.includes('LAT') || h.includes('緯度'));
    const lngIdx = headers.findIndex(h => h.includes('LON') || h.includes('經度'));

    const candidates = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = line.split(',');
      if (cols.length <= Math.max(latIdx, lngIdx)) continue;
      const lat = parseFloat(cols[latIdx]);
      const lng = parseFloat(cols[lngIdx]);
      if (isNaN(lat) || isNaN(lng)) continue;
      if (Math.abs(lat - centerLat) > 0.032 || Math.abs(lng - centerLng) > 0.035) continue;

      let rowParsed = cols;
      try { rowParsed = Utilities.parseCsv(line)[0]; } catch (e) {}
      const dLat = (lat - centerLat) * Math.PI / 180;
      const dLng = (lng - centerLng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(centerLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
                Math.sin(dLng / 2) * Math.sin(dLng / 2);
      const distM = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

      candidates.push({
        name: String(rowParsed[nameIdx] || 'AED 場所').trim(),
        addr: String(rowParsed[addrIdx] || '').trim(),
        place: String(rowParsed[placeIdx] || '').trim(),
        lat: lat,
        lng: lng,
        dist: distM
      });
    }

    candidates.sort((x, y) => x.dist - y.dist);
    return { ok: true, aeds: candidates.slice(0, 25), fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, aeds: [], error: err.message };
  }
}


/**
 * ================= v2.6 拍標籤辨識物資效期與規格（Gemini Vision API 代理） =================
 */
function recognizeItemLabelByGemini(imageBase64, hintItemName) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
  if (!apiKey) {
    return { ok: false, noKey: true, error: '尚未設定 GEMINI_API_KEY，已切換為手動規格快選模式' };
  }
  const cleanB64 = String(imageBase64 || '').replace(/^data:image\/[a-zA-Z]+;base64,/, '');
  if (!cleanB64) return { ok: false, error: '未收到影像資料' };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
  const promptText = '請辨識這張防災物資包裝或營養標示照片（參考品名：' + hintItemName + '），擷取並僅回傳 JSON 格式：' +
    '{"name":"辨識出的品名","expDate":"YYYY-MM-DD（若只有年月則補01，無則空字串）","specCode":"從以下擇一最接近之規格代碼：drink_600ml, drink_1500ml, drink_2000ml, drink_5000ml, util_10L, util_20L, toilet_1, food_300kcal, food_700kcal, food_2100kcal（若皆不符則填 custom）","specNote":"辨識到的容量或熱量文字摘要"}';

  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{
          parts: [
            { text: promptText },
            { inline_data: { mime_type: 'image/jpeg', data: cleanB64 } }
          ]
        }],
        generationConfig: { responseMimeType: 'application/json' }
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      return { ok: false, error: 'AI 辨識回應狀態 ' + res.getResponseCode() };
    }
    const json = JSON.parse(res.getContentText());
    const rawText = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(rawText || '{}');
    return { ok: true, recognized: parsed };
  } catch (e) {
    return { ok: false, error: '辨識解析失敗：' + e.message };
  }
}
