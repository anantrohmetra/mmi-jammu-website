// ══════════════════════════════════════════════════════════
//  MMI Jammu Portal — Google Apps Script Backend
//  Handles: Drive Gallery (per class) + Attendance +
//           Credentials + Calendar PDF serving
//
//  HOW TO DEPLOY:
//  1. Go to https://script.google.com → New project
//  2. Paste this entire file
//  3. Fill in the folder IDs and ATTENDANCE_SHEET_ID below
//  4. Click Deploy → New deployment → Web app
//     - Execute as: Me
//     - Who has access: Anyone
//  5. Copy the deployment URL → paste into scripts.js as APPS_SCRIPT_URL
// ══════════════════════════════════════════════════════════

// ── CONFIG ───────────────────────────────────────────────
const CLASS_FOLDERS = {
  'kindergarten': '1G0ypfTBSmqt9UcXc7EqLLn8jGrXZ9ew6',
  'nursery':      '1CrOUF4WDjUYOrRG9FY8rXUCLsbIwcz_x',
  'pre-nursery':  '17XWjwg1z98d5Nr_FTAhGtHT6-XCzomeu'
};
const ATTENDANCE_SHEET_ID  = '1_QJnpEm1x5AYdLO_btG5iXKmzZKTRG4fvSMICUX5tEw';

// Main "MMI Calendar PDFs" Drive folder — contains one subfolder per class.
// Each subfolder name must contain a recognisable class keyword (see _classFromFolderName).
// PDFs inside should have the month in their filename, e.g. "July 2026 Calendar.pdf"
// Share each PDF as "Anyone with the link → Viewer" for the iframe to work.
const CALENDAR_PDF_FOLDER_ID = '1otZm8HIYBOs96ys1keKaLMBV5u7LEIKp';
// ─────────────────────────────────────────────────────────

const _MONTH_MAP = {
  january:'01', february:'02', march:'03', april:'04',
  may:'05',     june:'06',     july:'07',  august:'08',
  september:'09', october:'10', november:'11', december:'12'
};

// ── REQUEST ROUTER ────────────────────────────────────────
function doGet(e) {
  const type    = (e.parameter.type    || '').toLowerCase();
  const student = (e.parameter.student || '').toLowerCase().trim();
  const cls     = (e.parameter.class   || '').toLowerCase().trim();

  let result;
  if      (type === 'gallery')   result = getGalleryImages(cls, student);
  else if (type === 'attendance') result = getAttendance(student);
  else if (type === 'getcreds')  result = getCredentials((e.parameter.key || '').toLowerCase().trim());
  else if (type === 'finduser')  result = findByUsername((e.parameter.username || '').toLowerCase().replace(/\s+/g, '').trim());
  else if (type === 'calpdfs')   result = getCalendarPDFs(cls, (e.parameter.section || '').toLowerCase().trim());
  else                           result = { error: 'Unknown type' };

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const type = (data.type || '').toLowerCase();
    let result;

    if (type === 'updatecreds') {
      result = updateCredentials(
        (data.key        || '').toLowerCase().trim(),
        data.currentPass || '',
        data.defaultPass || '',
        data.hasOwnProperty('newUsername') ? data.newUsername : null,
        data.hasOwnProperty('newPassword') ? data.newPassword : null
      );
    } else {
      result = { success: false, error: 'Unknown type' };
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── CALENDAR PDFs ─────────────────────────────────────────
// Returns { pdfs: [{id, name, month}] } for the given class key (k/n/p).
// PDFs directly in the class subfolder → all students in that class.
// PDFs in a subfolder named after the section → that section only.
// Section PDFs override class-wide PDFs for the same month.
function getCalendarPDFs(cls, section) {
  try {
    const root = DriveApp.getFolderById(CALENDAR_PDF_FOLDER_ID);
    const subs = root.getFolders();

    while (subs.hasNext()) {
      const sub  = subs.next();
      const code = _classFromFolderName(sub.getName());
      if (!code || _classFolderKey(code) !== cls) continue;

      const pdfMap = {}; // month → {id, name, month}

      function collectPDFs(folder) {
        const files = folder.getFiles();
        while (files.hasNext()) {
          const f = files.next();
          if (f.getMimeType() !== MimeType.PDF) continue;
          const name  = f.getName().replace(/^DONE_/i, '');
          const month = _monthFromFilename(name);
          if (month) pdfMap[month] = { id: f.getId(), name: name, month: month };
        }
      }

      // Class-wide PDFs (root of class folder)
      collectPDFs(sub);

      // Section-specific PDFs override class-wide ones for the same month
      if (section) {
        const secSubs = sub.getFoldersByName(section);
        if (secSubs.hasNext()) collectPDFs(secSubs.next());
      }

      const pdfs = Object.values(pdfMap).sort((a, b) => a.month.localeCompare(b.month));
      return { pdfs: pdfs };
    }
    return { pdfs: [] };
  } catch (err) {
    return { pdfs: [], error: err.message };
  }
}

// Maps folder class code → frontend key used by the portal (k / n / p)
function _classFolderKey(code) {
  if (code === 'K')                      return 'k';
  if (code === 'N')                      return 'n';
  return 'p'; // PN, P, T → p
}

// Detects class from subfolder name (case-insensitive)
function _classFromFolderName(name) {
  const n = name.toLowerCase();
  if (/\bkg\b|kindergarten/.test(n))         return 'K';
  if (/pre[-\s]?nursery|\bpn\b|pre/.test(n)) return 'PN';
  if (/nursery/.test(n))                      return 'N';
  if (/playgroup|\bpg\b/.test(n))             return 'P';
  if (/toddler/.test(n))                      return 'T';
  return null;
}

// Extracts YYYY-MM from a filename. Tries numeric format first, then month name.
function _monthFromFilename(filename) {
  const lower = filename.toLowerCase();
  const ym = lower.match(/(\d{4})[-_\s](\d{2})/);
  if (ym) return ym[1] + '-' + ym[2];
  for (const [name, num] of Object.entries(_MONTH_MAP)) {
    if (lower.includes(name)) {
      const yr = filename.match(/\d{4}/);
      return (yr ? yr[0] : new Date().getFullYear()) + '-' + num;
    }
  }
  return null;
}

// ── CREDENTIALS ───────────────────────────────────────────
// Sheet tab: "Credentials"  |  Columns: key | username | password | updated_at
function _getCredsSheet() {
  const ss = SpreadsheetApp.openById(ATTENDANCE_SHEET_ID);
  let sheet = ss.getSheetByName('Credentials');
  if (!sheet) {
    sheet = ss.insertSheet('Credentials');
    sheet.getRange(1, 1, 1, 4).setValues([['key', 'username', 'password', 'updated_at']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getCredentials(key) {
  if (!key) return { found: false };
  try {
    const sheet = _getCredsSheet();
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if ((data[i][0] || '').toString().toLowerCase().trim() === key) {
        return {
          found:    true,
          username: data[i][1] ? data[i][1].toString() : '',
          password: data[i][2] ? data[i][2].toString() : ''
        };
      }
    }
    return { found: false };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

function findByUsername(username) {
  if (!username) return { found: false };
  try {
    const sheet = _getCredsSheet();
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const stored = (data[i][1] || '').toString().toLowerCase().replace(/\s+/g, '').trim();
      if (stored && stored === username) {
        return { found: true, key: data[i][0].toString().toLowerCase().trim() };
      }
    }
    return { found: false };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

function updateCredentials(key, currentPass, defaultPass, newUsername, newPassword) {
  if (!key || !currentPass) return { success: false, error: 'Missing required fields' };
  try {
    const sheet        = _getCredsSheet();
    const data         = sheet.getDataRange().getValues();
    let   existingRow  = -1;
    let   storedPass   = defaultPass;

    for (let i = 1; i < data.length; i++) {
      if ((data[i][0] || '').toString().toLowerCase().trim() === key) {
        existingRow = i + 1;
        if (data[i][2]) storedPass = data[i][2].toString();
        break;
      }
    }

    if (currentPass !== storedPass) return { success: false, error: 'Current password is incorrect' };

    const now = new Date().toISOString();
    if (existingRow > 0) {
      const row  = sheet.getRange(existingRow, 1, 1, 4).getValues()[0];
      sheet.getRange(existingRow, 1, 1, 4).setValues([[
        key,
        newUsername !== null ? newUsername : row[1],
        newPassword !== null ? newPassword : row[2],
        now
      ]]);
    } else {
      sheet.appendRow([key, newUsername || '', newPassword || '', now]);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── GALLERY ───────────────────────────────────────────────
// Images directly in the class folder → visible to the whole class.
// Images inside a subfolder named after the student's username → that student only.
function getGalleryImages(cls, student) {
  try {
    const normalised = (cls === 'playgroup' || cls === 'toddlers') ? 'pre-nursery' : cls;
    const folderId   = CLASS_FOLDERS[normalised];
    if (!folderId || folderId.startsWith('PASTE_')) {
      return { images: [], error: 'No folder configured for class: ' + cls };
    }
    const folder = DriveApp.getFolderById(folderId);
    const images = [];

    function collectImages(f) {
      const files = f.getFiles();
      while (files.hasNext()) {
        const file = files.next();
        if (file.getMimeType().startsWith('image/')) {
          const id = file.getId();
          images.push({
            id:   id,
            name: file.getName(),
            url:  'https://drive.google.com/thumbnail?id=' + id + '&sz=w800'
          });
        }
      }
    }

    // Class-wide images (root of class folder)
    collectImages(folder);

    // Student-specific images (subfolder named after username)
    if (student) {
      const subs = folder.getFoldersByName(student);
      if (subs.hasNext()) collectImages(subs.next());
    }

    images.sort((a, b) => a.name.localeCompare(b.name));
    return { images: images };
  } catch (err) {
    return { error: err.message, images: [] };
  }
}

// ── ATTENDANCE ────────────────────────────────────────────
function getAttendance(student) {
  try {
    const ss      = SpreadsheetApp.openById(ATTENDANCE_SHEET_ID);
    const sheets  = ss.getSheets();
    const records = [];

    for (const sheet of sheets) {
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const row        = data[i];
        const rowStudent = (row[1] || '').toString().toLowerCase().trim();
        if (!row[0] || !row[1]) continue;
        if (!student || rowStudent === student) {
          const rawDate = row[0];
          let   dateStr;
          if (rawDate instanceof Date) {
            const y = rawDate.getFullYear();
            const m = String(rawDate.getMonth() + 1).padStart(2, '0');
            const d = String(rawDate.getDate()).padStart(2, '0');
            dateStr = y + '-' + m + '-' + d;
          } else {
            dateStr = rawDate.toString().trim();
          }
          records.push({
            date:    dateStr,
            student: row[1].toString(),
            status:  (row[2] || '').toString().toUpperCase().trim()
          });
        }
      }
    }
    return { records: records };
  } catch (err) {
    return { error: err.message, records: [] };
  }
}
