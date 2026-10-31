'use strict';

const VEILFORGE_BATCH_VAULT_V1 = 'VEILFORGE_BATCH_VAULT_V1';

async function saveBatchRecordsToVault(records, addEntry) {
  if (!Array.isArray(records)) throw new Error('LOCAL_BATCH_VAULT_RECORDS_INVALID');
  if (typeof addEntry !== 'function') throw new Error('LOCAL_BATCH_VAULT_WRITER_INVALID');
  const result = { requested: records.length, saved: 0, failed: 0, entries: [], errors: [], attachmentFiles: 0 };
  for (const record of records) {
    const text = String(record?.vaultText || '');
    if (!text) {
      result.failed += 1;
      result.errors.push({ id: String(record?.id || ''), sourceName: String(record?.sourceName || ''), error: 'LOCAL_BATCH_VAULT_TEXT_EMPTY' });
      continue;
    }
    const payload = {
      kind: 'redacted-text',
      name: `${String(record?.sourceName || '批处理结果').slice(0, 200)} · 批量脱敏`,
      text,
      findingCount: Math.max(0, Number(record?.findingCount || 0)),
      findingTypes: Array.isArray(record?.findingTypes) ? record.findingTypes.map(String) : []
    };
    try {
      const saved = await addEntry(payload, record);
      result.entries.push(saved);
      result.attachmentFiles += Number(saved?.attachmentResult?.files || 0);
      result.saved += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        id: String(record?.id || ''),
        sourceName: String(record?.sourceName || ''),
        error: String(error?.message || error)
      });
    }
  }
  return result;
}

module.exports = { VEILFORGE_BATCH_VAULT_V1, saveBatchRecordsToVault };
