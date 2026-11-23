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

// 後端版本號（WP-06）：每次請擁有者重貼 Code.gs 都要加一，並寫進 CHANGELOG 的 [gas] 標題
const BACKEND_VERSION = 'v1.9';

const PIN_MIN_LENGTH = 6;
const PIN_MAX_FAILURES = 10;           // 10 分鐘內猜錯 10 次就鎖定（#14：全域計數可被外人故意鎖住，放寬門檻）
const PIN_FAILURE_WINDOW_SEC = 600;
const PIN_LOCK_SEC = 600;              // 鎖定 10 分鐘
const PIN_COUNT_LOCK_WAIT_MS = 5000;   // 記錄猜錯次數時等鎖的上限
const PIN_FAIL_COUNT_KEY = 'pinFailCount';
const PIN_LOCKED_KEY = 'pinLocked';

/**
 * 檢查家庭通行碼（fail-closed）
 * - 未設定 FAMILY_PIN：一律拒絕（pinNotSet），由管理者在 GAS 指令碼屬性手動設定
 * - 猜錯次數過多：暫時鎖定（locked），鎖定期間正確通行碼也不接受
 * GAS 取不到來源 IP，因此失敗次數為全專案共用計數。
 * alreadyLocked：呼叫端（doPost）已持有 ScriptLock 時傳 true，避免重複等鎖。
 */
function checkAuthPin(providedPin, alreadyLocked) {
  const savedPin = PropertiesService.getScriptProperties().getProperty('FAMILY_PIN') || '';
  if (!savedPin) return { ok: false, pinNotSet: true };

  const cache = CacheService.getScriptCache();
  if (cache.get(PIN_LOCKED_KEY)) return { ok: false, locked: true };

  if (String(providedPin || '').trim() === savedPin) {
    cache.remove(PIN_FAIL_COUNT_KEY);
    return { ok: true, pinRequired: true };
  }

  return recordPinFailure(cache, alreadyLocked)
    ? { ok: false, locked: true }
    : { ok: false, pinRequired: true };
}

/**
 * 記錄一次猜錯；回傳 true 表示已達門檻（或已在鎖定中）。
 * 讀取計數、加一、寫回要在 ScriptLock 內做，否則同時送來的多個錯誤請求會讀到同一個數字，
 * 少算次數（#14）。POST 讀取沒有持鎖，這裡短暫取鎖；拿不到鎖時仍照常計數（盡力而為），不會因此放行。
 */
function recordPinFailure(cache, alreadyLocked) {
  let lock = null;
  if (!alreadyLocked) {
    try {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(PIN_COUNT_LOCK_WAIT_MS)) lock = null;
    } catch (err) {
      lock = null;
    }
  }
  try {
    if (cache.get(PIN_LOCKED_KEY)) return true;
    const fails = parseInt(cache.get(PIN_FAIL_COUNT_KEY) || '0', 10) + 1;
    if (fails >= PIN_MAX_FAILURES) {
      cache.put(PIN_LOCKED_KEY, '1', PIN_LOCK_SEC);
      cache.remove(PIN_FAIL_COUNT_KEY);
      return true;
    }
    cache.put(PIN_FAIL_COUNT_KEY, String(fails), PIN_FAILURE_WINDOW_SEC);
    return false;
  } finally {
    if (lock) lock.releaseLock();
  }
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

const READ_ACTIONS = ['getAll', 'getLocations', 'getContacts', 'getPlacePhoto'];
const GET_READ_DISABLED_MSG = '這個讀取方式已經停用。請重新整理 App，更新到最新版後再同步。';
const READ_PIN_ERROR = '請輸入正確的家庭通行碼以同步雲端資料';

/**
 * 讀取家庭資料（GET 與 POST 共用；呼叫前須已通過通行碼驗證）
 * 讀取不持全域鎖，所以一律「純讀取」：不新增分頁、不補成員列，補資料留給在鎖內的寫入流程（工程顧問，v1.6）。
 */
function readFamilyData(action, auth, payload) {
  if (action === 'getLocations') {
    return { ok: true, pinRequired: auth.pinRequired, locations: getLocationsData(true), serverTime: new Date().toISOString() };
  }
  if (action === 'getContacts') {
    return { ok: true, pinRequired: auth.pinRequired, contacts: getContactsData(true), serverTime: new Date().toISOString() };
  }
  if (action === 'getPlacePhoto') {
    return getPlacePhotoData(payload.placeId);
  }
  const inv = getInventoryData();
  return {
    ok: true,
    pinRequired: auth.pinRequired,
    inventory: inv,
    members: getMembersData(inv.characters, true),
    locations: getLocationsData(true),
    places: getPlacesData(true),
    contacts: getContactsData(true),
    snapshots: getSnapshotList(),
    backendVersion: BACKEND_VERSION,
    serverTime: new Date().toISOString()
  };
}

/**
 * 處理外部 PWA 的 GET 請求
 * 只提供公開防災情資（示警、AED）；家庭資料的 GET 讀取已在 v1.8 關閉（② #25，S-04）。
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action ? String(params.action) : '';

    // 公開防災情資代理（NCDR 與 AED 不涉及試算表個資，免通行碼即可查詢）
    if (action === 'getAlerts') {
      return createJsonOutput(getDisasterAlerts());
    }
    if (action === 'getAeds') {
      const lat = parseFloat(params.lat || '25.0330');
      const lng = parseFloat(params.lng || '121.5430');
      return createJsonOutput(getNearbyAeds(lat, lng));
    }

    // 家庭資料一律改用 POST 讀取，通行碼不放網址（② #25，S-04；前端 v2.9.23 起已改用 POST）。
    // 其他 GET 一律拒絕，包括沒帶 action 的請求。不讀網址上的 pin、不驗證，也不計入猜錯次數。
    return createJsonOutput({ ok: false, code: 'GET_READ_DISABLED', error: GET_READ_DISABLED_MSG });
  } catch (err) {
    return createJsonOutput({ ok: false, error: err.message });
  }
}

/**
 * 處理外部 PWA 的 POST 請求（前端以 Content-Type: text/plain 傳送 JSON 避免 CORS Preflight）
 */
function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);

    // 讀取家庭資料：通行碼放在 POST 本文，不放網址（S-04）。
    // 讀取不寫入試算表，不進全域鎖，避免排在寫入後面等最多 15 秒（工程顧問）。
    // 沒持鎖，所以 checkAuthPin 不傳 alreadyLocked：猜錯計數由 recordPinFailure 自己短暫取鎖。
    if (READ_ACTIONS.includes(payload.action)) {
      const readAuth = checkAuthPin(payload.pin);
      if (!readAuth.ok) {
        return authFailureOutput(readAuth, READ_PIN_ERROR);
      }
      return createJsonOutput(readFamilyData(payload.action, readAuth, payload));
    }
  } catch (err) {
    return createJsonOutput({ ok: false, error: err.message });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const action = payload.action;

    // 更新家庭通行碼：只接受「已知舊碼換新碼」；首次設定須由管理者在 GAS 指令碼屬性手動填入，
    // 也不接受換成空值（不可經 API 解除保護）
    if (action === 'setFamilyPin') {
      const pinAuth = checkAuthPin(payload.oldPin, true);
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

    // 驗證家庭通行碼
    const auth = checkAuthPin(payload.pin, true);
    if (!auth.ok) {
      return authFailureOutput(auth, '家庭通行碼驗證失敗，無法寫入雲端');
    }

    // 重送防重複（v1.7，工程顧問）：先驗通行碼，再查 reqId，最後才寫入。
    // 同一個 reqId 先前已寫入成功，就不再寫一次，回 duplicate 和 needSync 請前端重新同步。
    const reqId = IDEMPOTENT_SKIP_ACTIONS.includes(action) ? '' : validReqId(payload.reqId);
    if (reqId) {
      const remembered = getRememberedRequest(reqId);
      if (remembered !== null) return createJsonOutput(duplicateResponse(remembered));
    }

    // 物資寫入前先補齊穩定 ID（#26）；補 ID 失敗不影響本次寫入
    if (INVENTORY_WRITE_ACTIONS.includes(action)) {
      ensureItemIdsSafe();
    }

    const result = handleWriteAction(action, payload, auth);
    if (reqId && result && result.ok === true) rememberRequest(reqId, result);
    return createJsonOutput(result);
  } catch (err) {
    return createJsonOutput({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 寫入類操作（v1.7 從 doPost 拆出）：在全域鎖內、通行碼驗過後才呼叫，回傳要給前端的物件。
 */
function handleWriteAction(action, payload, auth) {
  if (action === 'updateItem') {
    const result = updateItemData(itemRefFrom(payload), payload.charName, payload.state, payload.expDate, payload.qty, payload.textNote, payload.spec);
    if (!result.ok) {
      return { ok: false, code: result.code, error: itemErrorMessage(result.code) };
    }
    return { ok: true, id: result.id, serverTime: new Date().toISOString() };
  }

  if (action === 'batchSync') {
    const actions = payload.actions || [];
    // 先確認物資頁存在；找不到就整批不寫，避免地點、聯絡人先寫入後重送時重複新增
    getTargetSheet(openFamilySpreadsheet());
    // 列號無效的物資更新只略過該筆，不整批中止，避免離線補傳佇列一直卡住（D-05 精神）
    // 每一筆都重新讀表、依 ID 找列（同一批先新增後修改時列號會位移）
    const skipped = [];
    const added = [];
    const duplicates = [];
    actions.forEach(act => {
      // 每一筆各自帶 reqId：先前已寫入成功的就略過；寫入成功才記下（重送防重複，v1.7）
      const actReqId = validReqId(act && act.reqId);
      if (actReqId && getRememberedRequest(actReqId) !== null) {
        duplicates.push(actReqId);
        return;
      }
      let actOk = true;
      if (act.action === 'updateItem') {
        const result = updateItemData(itemRefFrom(act), act.charName, act.state, act.expDate, act.qty, act.textNote, act.spec);
        if (!result.ok) {
          actOk = false;
          skipped.push({
            action: 'updateItem', code: result.code, row: act.row, charName: act.charName,
            itemId: act.itemId ? String(act.itemId) : '', itemName: result.itemName || (act.itemName ? String(act.itemName) : '')
          });
        }
      } else if (act.action === 'addItem') {
        const res = addNewItem(act.category, act.itemName, act.requiredChars || []);
        added.push({ itemName: String(act.itemName || '').trim(), category: String(act.category || '').trim(), id: res.id, tempRow: act.row || null });
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
      } else if (act.action === 'setMemberPlace') {
        if (!setMemberPlaceRecord(act.name, act.place)) {
          actOk = false;
          skipped.push({ action: 'setMemberPlace', code: 'UNKNOWN_MEMBER', charName: String(act.name || '') });
        }
      } else if (act.action === 'addPlace') {
        addPlaceRecord(act.place);
      } else if (act.action === 'updatePlace') {
        updatePlaceRecord(act.place);
      } else if (act.action === 'deletePlace') {
        deletePlaceRecord(act.id, act.reassignTo);
      }
      if (actOk && actReqId) rememberRequest(actReqId, REQ_DONE_MARK);
    });
    const inv = getInventoryData();
    return {
      ok: true,
      pinRequired: auth.pinRequired,
      inventory: inv,
      members: getMembersData(inv.characters),
      locations: getLocationsData(),
      places: getPlacesData(),
      contacts: getContactsData(),
      skipped: skipped,
      added: added,
      duplicates: duplicates,
      snapshots: getSnapshotList(),
      backendVersion: BACKEND_VERSION,
      serverTime: new Date().toISOString()
    };
  }

  if (action === 'addItem') {
    const res = addNewItem(payload.category, payload.itemName, payload.requiredChars || []);
    return { ok: true, id: res.id, inventory: getInventoryData(), serverTime: new Date().toISOString() };
  }

  if (action === 'editItem') {
    const res = editExistingItem(itemRefFrom(payload), payload.newName, payload.newCategory);
    if (!res.ok) {
      return { ok: false, code: res.code, error: itemErrorMessage(res.code), inventory: getInventoryData() };
    }
    return { ok: true, id: res.id, inventory: getInventoryData(), serverTime: new Date().toISOString() };
  }

  if (action === 'deleteItem') {
    const res = deleteExistingItem(itemRefFrom(payload));
    if (!res.ok) {
      return { ok: false, code: res.code, error: itemErrorMessage(res.code), inventory: getInventoryData() };
    }
    return { ok: true, inventory: getInventoryData(), serverTime: new Date().toISOString() };
  }

  // 成員管理 API（支援 10 欄：改名、頭像、血型、醫療、成員類型、行動能力、急救技能）
  if (action === 'addMember') {
    addMemberRecord(
      payload.name, payload.avatar, payload.buddy, payload.defaultState || '-',
      payload.blood, payload.medical, payload.iceContact, payload.rallyNote,
      payload.memberType, payload.mobility, payload.firstAidSkill, payload.place
    );
    const inv = getInventoryData();
    return {
      ok: true,
      inventory: inv,
      members: getMembersData(inv.characters),
      serverTime: new Date().toISOString()
    };
  }

  if (action === 'updateMember') {
    const oldName = payload.oldName || payload.name;
    const newName = payload.newName || payload.name;
    updateMemberRecord(
      oldName, newName, payload.avatar, payload.buddy,
      payload.blood, payload.medical, payload.iceContact, payload.rallyNote,
      payload.memberType, payload.mobility, payload.firstAidSkill, payload.place
    );
    const inv = getInventoryData();
    return {
      ok: true,
      inventory: inv,
      members: getMembersData(inv.characters),
      serverTime: new Date().toISOString()
    };
  }

  if (action === 'deleteMember') {
    deleteMemberRecord(payload.name);
    const inv = getInventoryData();
    return {
      ok: true,
      inventory: inv,
      members: getMembersData(inv.characters),
      serverTime: new Date().toISOString()
    };
  }

  // 地點與集合點管理 API
  if (action === 'addLocation') {
    addLocationRecord(payload.location);
    return { ok: true, locations: getLocationsData(), serverTime: new Date().toISOString() };
  }

  if (action === 'deleteLocation') {
    deleteLocationRecord(payload.id);
    return { ok: true, locations: getLocationsData(), serverTime: new Date().toISOString() };
  }

  // 存放地點與地點照片（v1.9）
  if (action === 'setMemberPlace') {
    if (!setMemberPlaceRecord(payload.name, payload.place)) {
      return { ok: false, code: 'UNKNOWN_MEMBER', error: '營地的成員名單裡找不到「' + String(payload.name || '') + '」，這次沒有存。請按「同步」後再選一次地點。' };
    }
    const inv = getInventoryData();
    return { ok: true, members: getMembersData(inv.characters), serverTime: new Date().toISOString() };
  }

  if (action === 'addPlace') {
    const id = addPlaceRecord(payload.place);
    return { ok: true, id: id, places: getPlacesData(), serverTime: new Date().toISOString() };
  }

  if (action === 'updatePlace') {
    updatePlaceRecord(payload.place);
    return { ok: true, places: getPlacesData(), serverTime: new Date().toISOString() };
  }

  if (action === 'deletePlace') {
    deletePlaceRecord(payload.id, payload.reassignTo);
    const inv = getInventoryData();
    return { ok: true, places: getPlacesData(), members: getMembersData(inv.characters), serverTime: new Date().toISOString() };
  }

  if (action === 'setPlacePhoto') {
    const photoVer = setPlacePhotoRecord(payload.placeId, payload.photoBase64);
    return { ok: true, photoVer: photoVer, places: getPlacesData(), serverTime: new Date().toISOString() };
  }

  if (action === 'deletePlacePhoto') {
    deletePlacePhotoRecord(payload.placeId);
    return { ok: true, places: getPlacesData(), serverTime: new Date().toISOString() };
  }

  // 家庭緊急聯絡網管理 API
  if (action === 'addContact') {
    addContactRecord(payload.contact);
    return { ok: true, contacts: getContactsData(), serverTime: new Date().toISOString() };
  }

  if (action === 'updateContact') {
    updateContactRecord(payload.contact);
    return { ok: true, contacts: getContactsData(), serverTime: new Date().toISOString() };
  }

  if (action === 'deleteContact') {
    deleteContactRecord(payload.id);
    return { ok: true, contacts: getContactsData(), serverTime: new Date().toISOString() };
  }

  if (action === 'createYearSnapshot') {
    return createYearSnapshot();
  }

  if (action === 'setGeminiKey') {
    const cleanKey = String(payload.apiKey || '').trim();
    if (cleanKey) PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', cleanKey);
    return { ok: true, hasGeminiKey: !!cleanKey, serverTime: new Date().toISOString() };
  }

  if (action === 'recognizeLabel') {
    return recognizeItemLabelByGemini(payload.imageBase64, payload.itemName || '');
  }

  return { ok: false, error: '未知的操作類型：' + action };
}
// 重送防重複（v1.7）：前端每個寫入帶一個 reqId，逾時或斷線重送時同一個 reqId 只寫一次。
// CacheService 是盡力而為：最多存 6 小時，而且 Google 可能提早清掉。清掉後重送仍可能重複新增，
// 所以這只是減少重複，不是保證；前端仍要在重送後同步，讓使用者看到雲端實際內容。
// 只記下小結果（新增物資的 id），不存整包資料：重送命中時回 needSync，請前端重新讀取最新資料，
// 不拿最舊可能是 6 小時前的資料覆蓋畫面（工程顧問）。
const REQ_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const REQ_CACHE_PREFIX = 'req:';
const REQ_CACHE_SEC = 21600;           // CacheService 上限 6 小時
const REQ_DONE_MARK = '1';
// 不需要防重複的操作：batchSync 改由每一筆各自的 reqId 處理；recognizeLabel 不寫入
const IDEMPOTENT_SKIP_ACTIONS = ['batchSync', 'recognizeLabel'];

/** reqId 格式不對就當沒帶（回空字串），照一般寫入處理，不擋請求。 */
function validReqId(value) {
  const id = typeof value === 'string' ? value : '';
  return REQ_ID_PATTERN.test(id) ? id : '';
}

/** 回傳先前記下的內容字串；沒有或快取讀取失敗回 null。 */
function getRememberedRequest(reqId) {
  try {
    const hit = CacheService.getScriptCache().get(REQ_CACHE_PREFIX + reqId);
    return (hit === null || hit === undefined) ? null : hit;
  } catch (err) {
    return null;
  }
}

/** 寫入成功後才記下：有新增物資的 id 就記 id，其餘只記「已完成」。快取寫不進去不影響本次回傳。 */
function rememberRequest(reqId, result) {
  try {
    const id = result && typeof result === 'object' && result.id ? String(result.id) : '';
    const text = id ? JSON.stringify({ id: id }) : REQ_DONE_MARK;
    CacheService.getScriptCache().put(REQ_CACHE_PREFIX + reqId, text, REQ_CACHE_SEC);
  } catch (err) {
    // 記不下來只是少了防重複，不影響已完成的寫入
  }
}

/** 重送命中：不附任何家庭資料，一律請前端重新同步；有記下 id 就一起回傳。 */
function duplicateResponse(remembered) {
  const out = { ok: true, duplicate: true, needSync: true, serverTime: new Date().toISOString() };
  if (remembered !== REQ_DONE_MARK) {
    try {
      const obj = JSON.parse(remembered);
      if (obj && obj.id) out.id = String(obj.id);
    } catch (err) {
      // 解析失敗就只回 needSync
    }
  }
  return out;
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
/**
 * 試算表公式注入防護（S-01 精神，進度表 #24、審查 V1）
 * 使用者輸入的字串若以 = + - @ 或 Tab、換行開頭，Sheets 會當成公式執行（例如 =IMPORTXML 可把表內資料送到外部）。
 * 寫入前前置單引號，強制存成純文字；讀回時 Sheets 不含這個單引號，顯示內容不變。
 * 單一字元（如 na 狀態的 '-'）不是公式，不處理。數字、日期等非字串原樣保留。
 */
function sanitizeCell(value) {
  if (typeof value !== 'string') return value;
  return (value.length > 1 && /^[=+\-@\t\r]/.test(value)) ? "'" + value : value;
}

function sanitizeRow(values) {
  return values.map(sanitizeCell);
}

// 不是物資表的固定分頁（v1.9 加上存放地點 Places 與地點照片 PlacePhotos，避免被誤認成物資表）
const FIXED_SHEET_NAMES = ['Leadsheet', 'Locations', 'Members', 'Contacts', 'Places', 'PlacePhotos'];

function getTargetSheet(ss) {
  const sheetName = (PropertiesService.getScriptProperties().getProperty('INVENTORY_SHEET_NAME') || '').trim();
  if (sheetName) {
    if (FIXED_SHEET_NAMES.includes(sheetName)) {
      throw new Error('INVENTORY_SHEET_NAME 不可設為「' + sheetName + '」（這是成員、聯絡人或地點用的分頁）。請改成物資分頁的名稱，例如「目前物資」');
    }
    const named = ss.getSheetByName(sheetName);
    if (!named) {
      throw new Error('找不到「' + sheetName + '」分頁，已暫停同步以免寫錯頁。請確認試算表的分頁名稱，或到 GAS 指令碼屬性修改 INVENTORY_SHEET_NAME');
    }
    return named;
  }
  const excluded = FIXED_SHEET_NAMES;
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    // 年度盤點快照（含手動做的「2026盤點」「2026 盤點 的副本」）不可當成物資頁（#15）
    if (!excluded.includes(name) && !SNAPSHOT_NAME_PATTERN.test(name)) return sheets[i];
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
      const itemId = parseItemId(notes[i] ? notes[i][1] : '');
      items.push({ row: i + 1, id: itemId, category: currentCategory, name: String(itemName).trim(), status: statusObj });
    }
  }
  return { sheetName: targetSheet.getName(), characters: characters.map(c => c.name), items: items };
}

function updateItemData(ref, charName, state, expDate, qty, textNote, spec) {
  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  // 定位物資（#26 穩定 ID；審查 V2 列號驗證）：只能寫到物資列。
  // doPost 全程持有 ScriptLock，定位與寫入在同一段鎖內，中間不會被別的請求插列。
  const loc = locateItemRow(targetSheet, data, charRowIndex, ref);
  if (!loc.ok) return loc;
  const rowNum = loc.rowNum;

  // 找不到成員欄時回報失敗，不可什麼都沒寫卻回成功
  const cleanChar = String(charName || '').trim();
  const colIndex = cleanChar === '確認日期' ? 0 : data[charRowIndex].map(v => String(v).trim()).indexOf(cleanChar) + 1;
  if (colIndex <= 2) {
    return { ok: false, code: 'UNKNOWN_MEMBER', itemName: loc.itemName };
  }
  const cell = targetSheet.getRange(rowNum, colIndex);

  if (state === 'ready') cell.setValue((qty && String(qty).trim() !== '') ? sanitizeCell(String(qty).trim()) : 'v');
  else if (state === 'missing') cell.setValue('x');
  else if (state === 'na') cell.setValue('-');

  const nowStamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  let noteParts = [];
  if (expDate && String(expDate).trim() !== '') noteParts.push('Date: ' + String(expDate).trim());
  if (spec && String(spec).trim() !== '') noteParts.push('Spec: ' + String(spec).trim());
  if (textNote && String(textNote).trim() !== '') noteParts.push('Note: ' + String(textNote).trim());
  noteParts.push('Updated: ' + nowStamp);

  cell.setNote(noteParts.join('\n'));
  return { ok: true, id: loc.id };
}

/**
 * 判斷 1 起算的列號是不是物資列（不是表頭、分類列、特殊列，也沒有超出範圍）
 * 分類列的判定與 getInventoryData 相同：所有成員欄都空白。
 */
function isInventoryItemRow(data, charRowIndex, rowNum) {
  if (!Number.isInteger(rowNum) || rowNum <= charRowIndex + 1 || rowNum > data.length) return false;
  const rowData = data[rowNum - 1];
  const itemName = String(rowData[1] || '').trim();
  if (!itemName || itemName === '確認日期' || itemName === '背包狀態確認' || itemName === '背包減重') return false;
  for (let i = 2; i < data[charRowIndex].length; i++) {
    const h = String(data[charRowIndex][i] || '').trim();
    if (!h || h === '確認日期') continue;
    if (rowData[i] !== '' && rowData[i] !== undefined) return true;
  }
  return false;
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
    targetSheet.getRange(lastRow + 1, 2).setValue(sanitizeCell(cleanCat));
    newItemRow = lastRow + 2;
  }

  const nameCell = targetSheet.getRange(newItemRow, 2);
  nameCell.setValue(sanitizeCell(cleanName));
  const newId = newItemId();
  nameCell.setNote(setItemIdInNote('', newId));  // 新插入的列沒有舊備註
  allChars.forEach(c => {
    const stateVal = requiredChars.includes(c.name) ? 'x' : '-';
    targetSheet.getRange(newItemRow, c.col).setValue(stateVal);
  });
  return { ok: true, id: newId };
}

function editExistingItem(ref, newName, newCategory) {
  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  const loc = locateItemRow(targetSheet, data, charRowIndex, ref);
  if (!loc.ok) return loc;
  const row = loc.rowNum;

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
  targetSheet.getRange(row, 2).setValue(sanitizeCell(cleanNewName));

  if (cleanNewCat === currentCat) return { ok: true, id: loc.id };

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
    targetSheet.getRange(lastRow + 1, 2).setValue(sanitizeCell(cleanNewCat));
    targetRow = lastRow + 2;
  }

  rowValues[1] = cleanNewName;
  const newRange = targetSheet.getRange(targetRow, 1, 1, maxCol);
  newRange.setValues([sanitizeRow(rowValues)]);
  newRange.setNotes([rowNotes]);  // B 欄備註（含 ID）跟著整列搬過去
  return { ok: true, id: loc.id };
}

function deleteExistingItem(ref) {
  const ss = openFamilySpreadsheet();
  const targetSheet = getTargetSheet(ss);
  const data = targetSheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);

  const loc = locateItemRow(targetSheet, data, charRowIndex, ref);
  if (!loc.ok) return loc;
  targetSheet.deleteRow(loc.rowNum);
  return { ok: true };
}

// ==========================================
// 一鍵年度快照（#15）：把物資頁複製成「YYYY 盤點」，只有擁有者可編輯
// ==========================================

const SNAPSHOT_NAME_PATTERN = /^\d{4}\s*盤點/;   // 自動挑物資頁時排除（含手動做的變形名稱）
const SNAPSHOT_LIST_PATTERN = /^\d{4} 盤點$/;    // 回傳給前端的快照清單只列標準名稱
const SNAPSHOT_CREATED_LABEL = '｜建立時間 ';

function createYearSnapshot() {
  const props = PropertiesService.getScriptProperties();
  if (!(props.getProperty('INVENTORY_SHEET_NAME') || '').trim()) {
    return { ok: false, code: 'SHEET_NAME_NOT_SET', error: '雲端還沒指定物資分頁，這次沒有留下盤點紀錄。請擁有者到 GAS 指令碼屬性設定 INVENTORY_SHEET_NAME' };
  }
  const ss = openFamilySpreadsheet();
  const source = getTargetSheet(ss);
  const now = new Date();
  const year = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy');
  const name = year + ' 盤點';
  const createdAt = Utilities.formatDate(now, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ss") + '+08:00';
  if (ss.getSheetByName(name)) {
    return { ok: false, code: 'SNAPSHOT_EXISTS', sheetName: name, error: '「' + name + '」已經有了，這次沒有重複建立' };
  }

  let copy = null;
  try {
    copy = source.copyTo(ss);
    // 改名前再查一次：鎖擋不住擁有者在試算表手動新增同名分頁
    if (ss.getSheetByName(name)) {
      ss.deleteSheet(copy);
      copy = null;
      return { ok: false, code: 'SNAPSHOT_EXISTS', sheetName: name, error: '「' + name + '」已經有了，這次沒有重複建立' };
    }
    copy.setName(name);
    ss.setActiveSheet(copy);
    ss.moveActiveSheet(ss.getNumSheets());
    const protection = copy.protect().setDescription(name + '（年度盤點紀錄，只有擁有者可修改）' + SNAPSHOT_CREATED_LABEL + createdAt);
    const others = protection.getEditors();
    if (others.length > 0) protection.removeEditors(others);
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
  } catch (err) {
    console.error('建立年度快照失敗：' + err.message);
    if (copy) {
      try {
        ss.deleteSheet(copy);  // 只刪這次 copyTo 回傳的分頁，不用名稱找
      } catch (delErr) {
        console.error('刪除未完成的快照失敗：' + delErr.message);
        let leftover = '';
        try { leftover = copy.getName(); } catch (e) { leftover = ''; }
        return {
          ok: false, code: 'SNAPSHOT_FAILED', leftoverSheet: leftover,
          error: '這次沒有留下盤點紀錄。試算表裡多了一頁沒做完的「' + leftover + '」，請到試算表把它刪掉後再按一次'
        };
      }
    }
    return { ok: false, code: 'SNAPSHOT_FAILED', error: '這次沒有留下盤點紀錄，請稍後再按一次' };
  }
  return { ok: true, sheetName: name, createdAt: createdAt, serverTime: new Date().toISOString() };
}

/**
 * 列出名稱為「YYYY 盤點」的分頁（唯讀，不寫入）。createdAt 取自 App 建立時寫在保護說明裡的時間；
 * 手動建立或讀不到時為空字串。讀取失敗回空陣列，不影響其他資料。
 */
function getSnapshotList() {
  try {
    const ss = openFamilySpreadsheet();
    return ss.getSheets()
      .filter(sh => SNAPSHOT_LIST_PATTERN.test(sh.getName()))
      .map(sh => {
        let createdAt = '';
        try {
          const prots = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
          for (let i = 0; i < prots.length; i++) {
            const desc = prots[i].getDescription() || '';
            const k = desc.indexOf(SNAPSHOT_CREATED_LABEL);
            if (k >= 0) { createdAt = desc.substring(k + SNAPSHOT_CREATED_LABEL.length).trim(); break; }
          }
        } catch (err) {
          createdAt = '';
        }
        return { sheetName: sh.getName(), createdAt: createdAt };
      });
  } catch (err) {
    console.error('讀取年度快照清單失敗：' + err.message);
    return [];
  }
}

// ==========================================
// 物資穩定 ID（#26，審查 C1、V3）
// ID 存在物資名稱格（B 欄）的備註，一行「ID:」開頭；備註其他行保留不動。
// ==========================================

const ITEM_ID_PREFIX = 'ID:';
const INVENTORY_WRITE_ACTIONS = ['updateItem', 'addItem', 'editItem', 'deleteItem', 'batchSync'];

function newItemId() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}

// 從 B 欄備註取出 ID；沒有就回空字串
function parseItemId(note) {
  if (!note) return '';
  const lines = String(note).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.indexOf(ITEM_ID_PREFIX) === 0) return line.substring(ITEM_ID_PREFIX.length).trim();
  }
  return '';
}

// 把 ID 寫進備註：取代原有的 ID 行，其他行原樣保留；原本沒有就加在最後一行
function setItemIdInNote(note, id) {
  const lines = note ? String(note).split('\n') : [];
  const kept = lines.filter(line => line.trim().indexOf(ITEM_ID_PREFIX) !== 0);
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(ITEM_ID_PREFIX + id);
  return kept.join('\n');
}

// 從請求取出物資定位資訊：itemId 優先，其次 itemName，最後只看列號（舊前端）
function itemRefFrom(p) {
  return {
    row: p ? p.row : undefined,
    itemId: p && p.itemId ? String(p.itemId).trim() : '',
    itemName: p && typeof p.itemName === 'string' ? p.itemName.trim() : ''
  };
}

function itemErrorMessage(code) {
  if (code === 'UNKNOWN_MEMBER') return '雲端找不到這位成員，請重新同步後再改一次';
  if (code === 'ITEM_NOT_FOUND') return '這項物資可能已被其他人修改或刪除，已改為不寫入，請重新同步後再確認';
  if (code === 'ITEM_MOVED') return '這項物資已經被其他人修改，已改為不寫入，請重新同步後再確認';
  return '這項物資在雲端的位置已經變了，請重新同步後再改一次';
}

function itemRowName(data, rowNum) {
  return String((data[rowNum - 1] && data[rowNum - 1][1]) || '').trim();
}

/**
 * 找出要寫入的物資列（1 起算）。
 * - 有 itemId：用 ID 找；找不到回 ITEM_NOT_FOUND，找到兩列以上（複製整列造成）回 ITEM_MOVED，
 *   找到的列不是物資列回 INVALID_ROW。
 * - 沒有 itemId、有 itemName：列號那一列名稱相同就用；不同就全表找同名，剛好一筆才用，否則 ITEM_MOVED。
 * - 兩者都沒有（舊前端）：維持只看列號，並檢查是物資列（V2）。
 */
function locateItemRow(sheet, data, charRowIndex, ref) {
  ref = ref || {};
  const firstRow = charRowIndex + 2;
  const okResult = rowNum => ({ ok: true, rowNum: rowNum, id: '', itemName: itemRowName(data, rowNum) });

  if (ref.itemId) {
    if (data.length < firstRow) return { ok: false, code: 'ITEM_NOT_FOUND' };
    const notes = sheet.getRange(firstRow, 2, data.length - firstRow + 1, 1).getNotes();
    const matches = [];
    for (let i = 0; i < notes.length; i++) {
      if (parseItemId(notes[i][0]) === ref.itemId) matches.push(firstRow + i);
    }
    if (matches.length === 0) return { ok: false, code: 'ITEM_NOT_FOUND', itemName: ref.itemName || '' };
    if (matches.length > 1) return { ok: false, code: 'ITEM_MOVED', itemName: ref.itemName || '' };
    if (!isInventoryItemRow(data, charRowIndex, matches[0])) return { ok: false, code: 'INVALID_ROW', itemName: ref.itemName || '' };
    const r = okResult(matches[0]);
    r.id = ref.itemId;
    return r;
  }

  const rowNum = Number(ref.row);
  if (ref.itemName) {
    if (isInventoryItemRow(data, charRowIndex, rowNum) && itemRowName(data, rowNum) === ref.itemName) {
      return withRowId(sheet, okResult(rowNum));
    }
    const matches = [];
    for (let r = firstRow; r <= data.length; r++) {
      if (itemRowName(data, r) === ref.itemName && isInventoryItemRow(data, charRowIndex, r)) matches.push(r);
    }
    if (matches.length === 1) return withRowId(sheet, okResult(matches[0]));
    return { ok: false, code: 'ITEM_MOVED', itemName: ref.itemName };
  }

  if (!isInventoryItemRow(data, charRowIndex, rowNum)) return { ok: false, code: 'INVALID_ROW' };
  return withRowId(sheet, okResult(rowNum));
}

// 補上該列現有的 ID（回傳給前端用）
function withRowId(sheet, result) {
  try {
    result.id = parseItemId(sheet.getRange(result.rowNum, 2).getNote());
  } catch (err) {
    result.id = '';
  }
  return result;
}

/**
 * 替缺 ID 或 ID 重複的物資列補發新 ID。
 * 重複的 ID（例如在試算表複製整列，備註跟著複製）每一筆都換新：無法判斷哪一列才是原本那項，
 * 換新後舊 ID 的寫入會回 ITEM_NOT_FOUND，前端重新同步取得新 ID，不會寫錯（D-01）。
 * 只處理物資列；全部都有且不重複時不寫入。回傳補發的筆數。
 */
function ensureItemIds(sheet) {
  const data = sheet.getDataRange().getValues();
  const charRowIndex = findCharRowIndex(data);
  const firstRow = charRowIndex + 2;
  if (data.length < firstRow) return 0;
  const range = sheet.getRange(firstRow, 2, data.length - firstRow + 1, 1);
  const notes = range.getNotes();
  const count = {};
  const isItem = [];
  for (let i = 0; i < notes.length; i++) {
    isItem[i] = isInventoryItemRow(data, charRowIndex, firstRow + i);
    const id = parseItemId(notes[i][0]);
    if (id) count[id] = (count[id] || 0) + 1;  // 分類列上的 ID 也算，避免新發的 ID 和它撞號
  }
  let changed = 0;
  for (let i = 0; i < notes.length; i++) {
    if (!isItem[i]) continue;
    const id = parseItemId(notes[i][0]);
    if (id && count[id] === 1) continue;
    let fresh = newItemId();
    while (count[fresh]) fresh = newItemId();
    count[fresh] = 1;
    notes[i][0] = setItemIdInNote(notes[i][0], fresh);
    changed++;
  }
  if (changed > 0) range.setNotes(notes);
  return changed;
}

// doPost 用：補 ID 失敗只記錄，不讓本次寫入失敗
function ensureItemIdsSafe() {
  try {
    ensureItemIds(getTargetSheet(openFamilySpreadsheet()));
  } catch (err) {
    console.error('補物資 ID 失敗：' + err.message);
  }
}

/**
 * 在編輯器手動執行一次：替所有物資補 ID、把重複的 ID 換新。部署後請先跑一次。
 */
function assignItemIds() {
  const changed = ensureItemIds(getTargetSheet(openFamilySpreadsheet()));
  console.log('已補發 ' + changed + ' 個物資 ID');
  return changed;
}

/**
 * 成員設定與家庭防災卡資料庫 (Members 工作表，擴充至 11 欄：
 * 名稱、頭像、夥伴動物、血型、過敏與用藥、緊急聯絡人、特殊醫療備註、成員類型、行動能力、急救技能、存放地點)
 * 存放地點（v1.9）：空白＝還沒選；home／car／work／other＝地點類型；plc_ 開頭＝Places 工作表的地點 ID。
 * 讀取時不轉換舊值（v1.6 讀取不寫入），使用者重新選地點時才寫入新值。
 */
const MEMBER_COLS = 11;
function getMembersSheet(ss, initialCharacters) {
  let sheet = ss.getSheetByName('Members');
  const headers = ['名稱', '頭像', '夥伴動物', '血型', '過敏與用藥', '緊急聯絡人', '特殊醫療備註', '成員類型', '行動能力', '急救技能', '存放地點'];
  // 只保留非個人的預設值；成員頭像與夥伴改由使用者在介面中設定
  const defaultMap = {
    '家庭儲備': { avatar: '⛺', buddy: '🐻', type: 'pack' }
  };

  if (!sheet) {
    sheet = ss.insertSheet('Members');
    sheet.getRange(1, 1, 1, MEMBER_COLS).setValues([headers]);
    sheet.setFrozenRows(1);
    if (initialCharacters && initialCharacters.length > 0) {
      const rows = initialCharacters.map(name => {
        const def = defaultMap[name] || { avatar: '🧑', buddy: '🐾', type: (name.endsWith('+') || name === '家庭儲備') ? 'pack' : 'main' };
        return [name, def.avatar, def.buddy, '', '', '', '', def.type, 'self', '', ''];
      });
      sheet.getRange(2, 1, rows.length, MEMBER_COLS).setValues(rows.map(sanitizeRow));
    }
  } else if (sheet.getLastColumn() < MEMBER_COLS) {
    sheet.getRange(1, 1, 1, MEMBER_COLS).setValues([headers]);
  }
  return sheet;
}

/**
 * readOnly：不持鎖的讀取用。分頁不存在時不建立，缺的成員只補在回傳資料裡、不寫進試算表。
 */
function getMembersData(initialCharacters, readOnly) {
  const ss = openFamilySpreadsheet();
  const sheet = readOnly ? ss.getSheetByName('Members') : getMembersSheet(ss, initialCharacters);
  const data = sheet ? sheet.getDataRange().getValues() : [];
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
      firstAidSkill: String(data[i][9] || ''),
      place: String(data[i][10] || '')
    };
  }
  if (initialCharacters) {
    initialCharacters.forEach(name => {
      if (!map[name]) {
        const defaultType = (name.endsWith('+') || name === '家庭儲備') ? 'pack' : 'main';
        map[name] = {
          name: name, avatar: '🧑', buddy: '🐾', blood: '', medical: '', iceContact: '', rallyNote: '',
          memberType: defaultType, mobility: 'self', firstAidSkill: '', place: ''
        };
        if (!readOnly) sheet.appendRow(sanitizeRow([name, '🧑', '🐾', '', '', '', '', defaultType, 'self', '', '']));
      }
    });
  }
  return map;
}

function addMemberRecord(name, avatar, buddy, defaultState, blood, medical, iceContact, rallyNote, memberType, mobility, firstAidSkill, place) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('成員名稱不可為空');
  // 先檢查存放地點，不合格就整筆不寫，避免物資表已加欄、成員表卻沒寫入
  const cleanPlace = (place === undefined || place === '') ? '' : requireMemberPlace(place);

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
  targetSheet.getRange(charRowIndex + 1, insertCol).setValue(sanitizeCell(cleanName));

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
      targetSheet.getRange(r + 1, insertCol).setValue(sanitizeCell(defaultState));
    }
  }

  const mType = memberType || ((cleanName.endsWith('+') || cleanName === '家庭儲備') ? 'pack' : 'main');
  const mSheet = getMembersSheet(ss, []);
  mSheet.appendRow(sanitizeRow([
    cleanName, avatar || '🧑', buddy || '🐾',
    blood || '', medical || '', iceContact || '', rallyNote || '',
    mType, mobility || 'self', firstAidSkill || '', cleanPlace
  ]));
  return true;
}

function updateMemberRecord(oldName, newName, avatar, buddy, blood, medical, iceContact, rallyNote, memberType, mobility, firstAidSkill, place) {
  const cleanOld = (oldName || '').trim();
  const cleanNew = (newName || cleanOld).trim();
  if (!cleanOld || !cleanNew) throw new Error('成員名稱不可為空');
  // 沒帶 place（舊版前端）就不動這一欄；帶了就要是合格的值，不接受改回空白
  const cleanPlace = (place === undefined) ? undefined : requireMemberPlace(place);

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
      targetSheet.getRange(charRowIndex + 1, oldCol).setValue(sanitizeCell(cleanNew));
    }
  }

  const sheet = getMembersSheet(ss, []);
  const mData = sheet.getDataRange().getValues();
  for (let i = 1; i < mData.length; i++) {
    if (String(mData[i][0]).trim() === cleanOld) {
      sheet.getRange(i + 1, 1).setValue(sanitizeCell(cleanNew));
      if (avatar !== undefined) sheet.getRange(i + 1, 2).setValue(sanitizeCell(avatar || '🧑'));
      if (buddy !== undefined) sheet.getRange(i + 1, 3).setValue(sanitizeCell(buddy || '🐾'));
      if (blood !== undefined) sheet.getRange(i + 1, 4).setValue(sanitizeCell(blood));
      if (medical !== undefined) sheet.getRange(i + 1, 5).setValue(sanitizeCell(medical));
      if (iceContact !== undefined) sheet.getRange(i + 1, 6).setValue(sanitizeCell(iceContact));
      if (rallyNote !== undefined) sheet.getRange(i + 1, 7).setValue(sanitizeCell(rallyNote));
      if (memberType !== undefined) sheet.getRange(i + 1, 8).setValue(sanitizeCell(memberType));
      if (mobility !== undefined) sheet.getRange(i + 1, 9).setValue(sanitizeCell(mobility));
      if (firstAidSkill !== undefined) sheet.getRange(i + 1, 10).setValue(sanitizeCell(firstAidSkill));
      if (cleanPlace !== undefined) sheet.getRange(i + 1, 11).setValue(cleanPlace);
      return true;
    }
  }
  const mType = memberType || ((cleanNew.endsWith('+') || cleanNew === '家庭儲備') ? 'pack' : 'main');
  sheet.appendRow(sanitizeRow([
    cleanNew, avatar || '🧑', buddy || '🐾',
    blood || '', medical || '', iceContact || '', rallyNote || '',
    mType, mobility || 'self', firstAidSkill || '', cleanPlace || ''
  ]));
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

function getContactsData(readOnly) {
  const ss = openFamilySpreadsheet();
  const sheet = readOnly ? ss.getSheetByName('Contacts') : getContactsSheet(ss); // readOnly：不建立分頁
  const data = sheet ? sheet.getDataRange().getValues() : [];
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
  sheet.appendRow(sanitizeRow([
    id,
    String(contact.name).trim(),
    contact.group || 'core',
    contact.relation || '',
    contact.phone || '',
    contact.region || '',
    contact.note || ''
  ]));
  return true;
}

function updateContactRecord(contact) {
  if (!contact || !contact.id) throw new Error('無效的聯絡人編號');
  const ss = openFamilySpreadsheet();
  const sheet = getContactsSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(contact.id)) {
      sheet.getRange(i + 1, 2, 1, 6).setValues([sanitizeRow([
        String(contact.name || '').trim(),
        contact.group || 'core',
        contact.relation || '',
        contact.phone || '',
        contact.region || '',
        contact.note || ''
      ])]);
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

function getLocationsData(readOnly) {
  const ss = openFamilySpreadsheet();
  const sheet = readOnly ? ss.getSheetByName('Locations') : getLocationsSheet(ss); // readOnly：不建立分頁
  const data = sheet ? sheet.getDataRange().getValues() : [];
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
  sheet.appendRow(sanitizeRow([
    id,
    loc.name,
    loc.type || '避難處所',
    Number(loc.lat),
    Number(loc.lng),
    loc.note || '',
    loc.creator || ''
  ]));
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
 * 存放地點（v1.9，Places 工作表）：物資包放在哪裡，例如家裡、車上、公司。
 * 跟地圖上的避難點位（Locations）分開：存放地點不記經緯度，家裡的位置不會畫到地圖上。
 * 欄位：地點 ID、名稱、類型、人數、照片版本、照片段數、更新時間、建立者
 */
const PLACE_TYPES = ['home', 'car', 'work', 'other'];
const PLACE_ID_PATTERN = /^plc_[A-Za-z0-9-]{1,64}$/;
const PLACE_NAME_MAX = 30;
const PLACE_HEADCOUNT_MAX = 50;
const PLACE_HEADERS = ['地點 ID', '名稱', '類型', '人數', '照片版本', '照片段數', '更新時間', '建立者'];
const PLACE_NOT_FOUND_MSG = '找不到這個存放地點，可能已被家人刪除。請按「同步」看最新的地點清單。';

// 地點照片（PlacePhotos 工作表）：前端先縮成長邊 800px、拿掉 EXIF 的 JPEG，再以 base64 送來。
// 一格最多 5 萬字，所以切段存；不用雲端硬碟，免得每個家庭都要重新授權整個雲端硬碟（工程顧問）。
const PHOTO_HEADERS = ['地點 ID', '照片版本', '段序', '資料'];
const PHOTO_MAX_CHARS = 300000;        // 約 220KB 的 JPEG
const PHOTO_CHUNK_CHARS = 40000;
const PHOTO_CHUNK_PREFIX = 'b';        // 每段前面加一個字母，避免以 + = 開頭被試算表當成公式或數字

function validMemberPlace(value) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (PLACE_TYPES.includes(v) || PLACE_ID_PATTERN.test(v)) return v;
  return null;
}

function requireMemberPlace(value) {
  const v = validMemberPlace(value);
  if (v === null) throw new Error('存放地點的格式不正確，這次沒有存。請重新整理 App 後再選一次地點。');
  return v;
}

/**
 * 只改一個包的存放地點（可離線補傳；不像 updateMember 會在找不到時新增一列）。
 * 找不到這個包就回 false，由呼叫端回 UNKNOWN_MEMBER。
 */
function setMemberPlaceRecord(name, place) {
  const cleanName = String(name || '').trim();
  const cleanPlace = requireMemberPlace(place);
  if (!cleanName) return false;
  const ss = openFamilySpreadsheet();
  const sheet = getMembersSheet(ss, []);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === cleanName) {
      sheet.getRange(i + 1, 11).setValue(cleanPlace);
      return true;
    }
  }
  return false;
}

function getPlacesSheet(ss, readOnly) {
  let sheet = ss.getSheetByName('Places');
  if (!sheet && !readOnly) {
    sheet = ss.insertSheet('Places');
    sheet.getRange(1, 1, 1, PLACE_HEADERS.length).setValues([PLACE_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getPlacePhotosSheet(ss, readOnly) {
  let sheet = ss.getSheetByName('PlacePhotos');
  if (!sheet && !readOnly) {
    sheet = ss.insertSheet('PlacePhotos');
    sheet.getRange(1, 1, 1, PHOTO_HEADERS.length).setValues([PHOTO_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * readOnly：不持鎖的讀取用，分頁不存在時不建立，回空清單。
 * 不回照片本身（照片另外用 getPlacePhoto 取），只回 photoVer 讓前端知道有沒有照片、要不要重抓。
 */
function getPlacesData(readOnly) {
  const ss = openFamilySpreadsheet();
  const sheet = getPlacesSheet(ss, readOnly);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const places = [];
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][0] || '').trim();
    if (!PLACE_ID_PATTERN.test(id)) continue;
    const type = String(data[i][2] || '');
    places.push({
      id: id,
      name: String(data[i][1] || ''),
      type: PLACE_TYPES.includes(type) ? type : 'other',
      headcount: cleanHeadcount(data[i][3]),
      photoVer: String(data[i][4] || ''),
      updatedAt: String(data[i][6] || ''),
      creator: String(data[i][7] || '')
    });
  }
  return places;
}

function cleanHeadcount(value) {
  const n = Math.floor(Number(value));
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(n, PLACE_HEADCOUNT_MAX);
}

function cleanPlaceName(value) {
  const name = String(value === undefined || value === null ? '' : value).trim();
  if (!name) throw new Error('請幫這個存放地點取個名字，例如「家裡」或「爸爸的車」。');
  if (name.length > PLACE_NAME_MAX) throw new Error('存放地點的名字請在 ' + PLACE_NAME_MAX + ' 個字以內。');
  return name;
}

function cleanPlaceType(value) {
  const type = String(value || '').trim();
  if (!PLACE_TYPES.includes(type)) throw new Error('存放地點的類型不正確，這次沒有存。請重新整理 App 後再試一次。');
  return type;
}

function findPlaceRow(data, id) {
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === id) return i;
  }
  return -1;
}

/**
 * 新增存放地點。前端離線時會先自己產生 plc_ ID（包要先指向它），補傳時沿用；
 * 同一個 ID 已存在就不再新增，重送不會多一筆。
 */
function addPlaceRecord(place) {
  const p = place || {};
  const name = cleanPlaceName(p.name);
  const type = cleanPlaceType(p.type);
  const headcount = cleanHeadcount(p.headcount);
  const id = PLACE_ID_PATTERN.test(String(p.id || '')) ? String(p.id) : ('plc_' + Utilities.getUuid());
  const ss = openFamilySpreadsheet();
  const sheet = getPlacesSheet(ss);
  if (findPlaceRow(sheet.getDataRange().getValues(), id) >= 1) return id;
  const creator = String(p.creator || '').trim().slice(0, PLACE_NAME_MAX);
  sheet.appendRow(sanitizeRow([id, name, type, headcount, '', 0, new Date().toISOString(), creator]));
  return id;
}

function updatePlaceRecord(place) {
  const p = place || {};
  const id = String(p.id || '');
  if (!PLACE_ID_PATTERN.test(id)) throw new Error(PLACE_NOT_FOUND_MSG);
  const ss = openFamilySpreadsheet();
  const sheet = getPlacesSheet(ss);
  const row = findPlaceRow(sheet.getDataRange().getValues(), id);
  if (row < 1) throw new Error(PLACE_NOT_FOUND_MSG);
  // 先全部檢查完再寫，避免改到一半
  const name = p.name !== undefined ? cleanPlaceName(p.name) : undefined;
  const type = p.type !== undefined ? cleanPlaceType(p.type) : undefined;
  const headcount = p.headcount !== undefined ? cleanHeadcount(p.headcount) : undefined;
  if (name !== undefined) sheet.getRange(row + 1, 2).setValue(sanitizeCell(name));
  if (type !== undefined) sheet.getRange(row + 1, 3).setValue(type);
  if (headcount !== undefined) sheet.getRange(row + 1, 4).setValue(headcount);
  sheet.getRange(row + 1, 7).setValue(new Date().toISOString());
  return true;
}

/**
 * 刪除存放地點：同一次持鎖動作裡一起刪掉照片（工程顧問、災防顧問）。
 * reassignTo：放在這個地點的包要改放哪裡（前端先問使用者）。
 *   空字串＝改成「還沒選」；合格的地點值＝改放那裡；沒給（undefined）＝留著舊 ID，前端顯示「地點不見了」，不算成家裡（D-01）。
 * 已經不存在就回 false，不丟錯，重送不會卡住離線佇列。
 */
function deletePlaceRecord(id, reassignTo) {
  const placeId = String(id || '');
  if (!PLACE_ID_PATTERN.test(placeId)) return false;
  let target;
  if (reassignTo === '') {
    target = '';
  } else if (reassignTo !== undefined && reassignTo !== null) {
    target = requireMemberPlace(reassignTo);
    if (target === placeId) throw new Error('要改放的地點不能是正在刪除的地點，請選另一個地點。');
  }
  const ss = openFamilySpreadsheet();
  // 要改放的地點若是 plc_ ID，必須真的存在，否則包會指向一個不存在的地點（工程顧問）
  if (target && PLACE_ID_PATTERN.test(target) && findPlaceRow(getPlacesSheet(ss).getDataRange().getValues(), target) < 1) {
    throw new Error('要改放的地點已經不在了，請按「同步」看最新的地點清單後再刪一次。');
  }
  if (target !== undefined) {
    const mSheet = getMembersSheet(ss, []);
    const mData = mSheet.getDataRange().getValues();
    for (let i = 1; i < mData.length; i++) {
      if (String(mData[i][10] || '').trim() === placeId) mSheet.getRange(i + 1, 11).setValue(target);
    }
  }
  deletePhotoChunks(ss, placeId, null);
  const sheet = getPlacesSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() === placeId) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

/**
 * 刪掉某個地點的照片段；keepVer 有值時保留那一版（換照片時先寫新的、再刪舊的）
 */
function deletePhotoChunks(ss, placeId, keepVer) {
  const sheet = getPlacePhotosSheet(ss, true);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() === placeId && (keepVer === null || String(data[i][1]) !== keepVer)) {
      sheet.deleteRow(i + 1);
    }
  }
}

function checkPhotoBase64(value) {
  const b64 = String(value || '');
  if (!b64) throw new Error('沒有收到照片，請再拍一次。');
  if (b64.length > PHOTO_MAX_CHARS) throw new Error('照片太大了，這次沒有存。請重新整理 App 後再拍一次。');
  // 只收 JPEG（base64 開頭 /9j/ 是 JPEG 的檔頭）
  if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(b64) || b64.indexOf('/9j/') !== 0) {
    throw new Error('照片格式不正確，請再拍一次。');
  }
  return b64;
}

/**
 * 換地點照片：先寫新的一版，再把地點指向新版，最後刪舊版。
 * 讀取不持鎖，這個順序讓讀到的永遠是完整的舊版或新版。
 */
function setPlacePhotoRecord(placeId, photoBase64) {
  const id = String(placeId || '');
  if (!PLACE_ID_PATTERN.test(id)) throw new Error(PLACE_NOT_FOUND_MSG);
  const b64 = checkPhotoBase64(photoBase64);
  const ss = openFamilySpreadsheet();
  const pSheet = getPlacesSheet(ss);
  const row = findPlaceRow(pSheet.getDataRange().getValues(), id);
  if (row < 1) throw new Error(PLACE_NOT_FOUND_MSG);

  // 版本號要每次都不同，否則同一毫秒內連換兩次，刪舊版時會留下兩份同版本的段
  const ver = new Date().getTime() + '-' + Utilities.getUuid().slice(0, 8);
  const rows = [];
  for (let i = 0, n = 0; i < b64.length; i += PHOTO_CHUNK_CHARS, n++) {
    rows.push([id, ver, n, PHOTO_CHUNK_PREFIX + b64.slice(i, i + PHOTO_CHUNK_CHARS)]);
  }
  const photoSheet = getPlacePhotosSheet(ss);
  const start = Math.max(photoSheet.getLastRow(), 1) + 1;
  photoSheet.getRange(start, 1, rows.length, PHOTO_HEADERS.length).setValues(rows);

  pSheet.getRange(row + 1, 5, 1, 3).setValues([[ver, rows.length, new Date().toISOString()]]);
  deletePhotoChunks(ss, id, ver);
  return ver;
}

function deletePlacePhotoRecord(placeId) {
  const id = String(placeId || '');
  if (!PLACE_ID_PATTERN.test(id)) return false;
  const ss = openFamilySpreadsheet();
  const pSheet = getPlacesSheet(ss);
  const row = findPlaceRow(pSheet.getDataRange().getValues(), id);
  if (row >= 1) pSheet.getRange(row + 1, 5, 1, 3).setValues([['', 0, new Date().toISOString()]]);
  deletePhotoChunks(ss, id, null);
  return true;
}

/**
 * 讀地點照片（POST＋通行碼，不持鎖、不寫入）。
 * 段數對不上（剛好在換照片）就回 PHOTO_NOT_READY，不回半張照片。
 */
function getPlacePhotoData(placeId) {
  const id = String(placeId || '');
  if (!PLACE_ID_PATTERN.test(id)) return { ok: false, code: 'PLACE_NOT_FOUND', error: PLACE_NOT_FOUND_MSG };
  const ss = openFamilySpreadsheet();
  const pSheet = getPlacesSheet(ss, true);
  const pData = pSheet ? pSheet.getDataRange().getValues() : [];
  const row = findPlaceRow(pData, id);
  if (row < 1) return { ok: false, code: 'PLACE_NOT_FOUND', error: PLACE_NOT_FOUND_MSG };
  const ver = String(pData[row][4] || '');
  const count = Number(pData[row][5]) || 0;
  if (!ver || count < 1) return { ok: true, placeId: id, photoVer: '', photoBase64: '', serverTime: new Date().toISOString() };

  // 先只讀前三欄（地點 ID、版本、段序）找到第一段，避免每次都讀進全部照片（工程顧問，D-06）。
  // 同一版的各段是一次寫入、連在一起的，所以從第一段起一次讀 count 列。
  // 讀取不持鎖，兩次讀之間別人可能換照片或刪地點、讓列往上移，所以每一列都要再核對 ID、版本、段序，
  // 對不上就回 PHOTO_NOT_READY，不回拼錯的照片（工程顧問）。
  const notReady = { ok: false, code: 'PHOTO_NOT_READY', error: '照片正在更新，請過一下再看一次。' };
  const photoSheet = getPlacePhotosSheet(ss, true);
  const lastRow = photoSheet ? photoSheet.getLastRow() : 0;
  const index = lastRow > 1 ? photoSheet.getRange(2, 1, lastRow - 1, 3).getValues() : [];
  let first = -1;
  for (let i = 0; i < index.length; i++) {
    if (String(index[i][0]).trim() === id && String(index[i][1]) === ver && Number(index[i][2]) === 0) { first = i + 2; break; }
  }
  if (first < 0) return notReady;
  const rows = photoSheet.getRange(first, 1, count, PHOTO_HEADERS.length).getValues();
  const parts = [];
  for (let n = 0; n < count; n++) {
    const r = rows[n] || [];
    if (String(r[0]).trim() !== id || String(r[1]) !== ver || Number(r[2]) !== n) return notReady;
    parts.push(String(r[3] || '').slice(PHOTO_CHUNK_PREFIX.length));
  }
  return { ok: true, placeId: id, photoVer: ver, photoBase64: parts.join(''), serverTime: new Date().toISOString() };
}

// 示警快取（進度表 #16）：只快取成功且有筆數的結果，存 3 分鐘。
// 前端從 fetchedAt 起算 15 分鐘新鮮度，快取不延長這段時間；代價是最多 3 分鐘內抓不到新發的示警。
const ALERTS_CACHE_KEY = 'ncdrAlerts_v3';  // v2：多了 limit、feedCount、truncated；v3：每則多了 effective、expires、msgType、status
const ALERTS_CACHE_SEC = 180;
const ALERTS_CACHE_MAX_BYTES = 90000;  // CacheService 單筆上限 100KB（以 UTF-8 位元組計，中文一字 3 位元組），留餘裕

/**
 * 取得 NCDR 示警，先看快取（D-01、D-02、D-06）
 * - 命中快取：原樣回傳，fetchedAt 仍是當初實際抓 NCDR 的時間，另加 cached: true
 * - 未命中：現抓；只有 ok 且至少 1 筆時才寫入快取
 * - 抓取失敗或整包 0 筆：照實回傳，不寫快取，也不拿舊快取冒充成功
 */
function getDisasterAlerts() {
  let cache = null;
  try {
    cache = CacheService.getScriptCache();
    const hit = cache.get(ALERTS_CACHE_KEY);
    if (hit) {
      const cached = JSON.parse(hit);
      if (cached && cached.ok === true && Array.isArray(cached.alerts) && cached.alerts.length > 0 && cached.fetchedAt) {
        cached.cached = true;
        return cached;
      }
    }
  } catch (err) {
    // 快取讀取或解析失敗就當沒有快取，改為現抓
  }

  const fresh = fetchDisasterAlertsFromNcdr();
  fresh.cached = false;
  if (cache && fresh.ok === true && fresh.alerts.length > 0) {
    try {
      const text = JSON.stringify(fresh);
      const bytes = Utilities.newBlob(text).getBytes().length;
      if (bytes <= ALERTS_CACHE_MAX_BYTES) cache.put(ALERTS_CACHE_KEY, text, ALERTS_CACHE_SEC);
    } catch (err) {
      // 寫不進快取不影響本次回傳
    }
  }
  return fresh;
}

// 示警筆數上限（進度表 #21）：原為 30 則，颱風豪雨時全國示警容易超過，會把仍在 12 小時內的示警切掉（D-01）。
// 前端用回傳的 limit、truncated 判斷是否被截斷，不再寫死 30。
const ALERTS_MAX_ENTRIES = 100;

/**
 * 把 NCDR feed 的 CAP 時間（例如「2026/11/17 下午 08:08:40」，台灣本地時間）轉成 ISO 8601 字串
 * 「2026-11-17T20:08:40+08:00」。已是 ISO 格式就原樣回傳；看不懂就回 null（前端遇 null 改用舊規則，不可把示警藏起來）。
 */
function parseCapTime(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(t)) return t;
  const m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/i);
  if (!m) return null;
  let hour = parseInt(m[5], 10);
  const marker = (m[4] || '').toUpperCase();
  if (marker) {
    if (hour < 1 || hour > 12) return null;
    const pm = marker === '下午' || marker === 'PM';
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const month = parseInt(m[2], 10), day = parseInt(m[3], 10), minute = parseInt(m[6], 10), second = parseInt(m[7] || '0', 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  // 不存在的日期（例如 2/31）回 null，避免前端自動進位成下個月
  const check = new Date(Date.UTC(parseInt(m[1], 10), month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const pad = n => (n < 10 ? '0' : '') + n;
  return m[1] + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hour) + ':' + pad(minute) + ':' + pad(second) + '+08:00';
}

/**
 * 代理抓取 NCDR 民生示警公開資料平台 ATOM Feed（免金鑰），並自動標記屬於細胞廣播 (CBS) 等級之緊急告警
 * fetchedAt 為實際向 NCDR 抓取的時間，快取命中時不改寫。
 */
function fetchDisasterAlertsFromNcdr() {
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
    // CAP 欄位的命名空間宣告在 feed 根元素；找不到就用 CAP 1.1 的網址
    const capNs = root.getNamespace('cap') || XmlService.getNamespace('cap', 'urn:oasis:names:tc:emergency:cap:1.1');
    const entries = root.getChildren('entry', ns);
    const alerts = [];

    for (let i = 0; i < Math.min(entries.length, ALERTS_MAX_ENTRIES); i++) {
      const entry = entries[i];
      const title = (entry.getChildText('title', ns) || '').trim();
      const updated = (entry.getChildText('updated', ns) || '').trim();
      const summary = (entry.getChildText('summary', ns) || '').replace(/<[^>]+>/g, '').trim();
      const authorEl = entry.getChild('author', ns);
      const author = authorEl ? (authorEl.getChildText('name', ns) || '').trim() : '';
      const linkEl = entry.getChild('link', ns);
      const link = linkEl ? (linkEl.getAttribute('href') ? linkEl.getAttribute('href').getValue() : '') : '';
      const isCbs = cbsRegex.test(title) || cbsRegex.test(summary);
      // 示警本身的有效時間（進度表 #18）：讓前端改看「還在有效期內」而不只看最後更新時間
      const effective = parseCapTime(entry.getChildText('effective', capNs));
      const expires = parseCapTime(entry.getChildText('expires', capNs));
      const msgType = (entry.getChildText('msgType', capNs) || '').trim();
      const status = (entry.getChildText('status', capNs) || '').trim();

      alerts.push({
        title: title,
        updated: updated,
        summary: summary,
        author: author,
        link: link,
        isCbs: isCbs,
        effective: effective,   // 生效時間，ISO 8601（+08:00）；解析失敗為 null
        expires: expires,       // 失效時間，同上
        msgType: msgType,       // CAP 訊息類型：Alert／Update／Cancel，原樣
        status: status          // CAP 狀態：Actual／Exercise／Test 等，原樣
      });
    }
    return {
      ok: true,
      alerts: alerts,
      fetchedAt: new Date().toISOString(),
      limit: ALERTS_MAX_ENTRIES,            // 本次最多回傳幾則
      feedCount: entries.length,            // NCDR 來源實際有幾則
      truncated: entries.length > ALERTS_MAX_ENTRIES  // 來源超過上限、有示警沒回傳
    };
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
