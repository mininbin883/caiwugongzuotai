'use strict';

const path = require('node:path');

const FEATURE_DEFINITIONS = Object.freeze([
  { key: 'pivotTables', label: '透视表与缓存', patterns: [/\/pivotTables?\//i, /\/pivotCache/i, /\/pivotTable/i], note: '部件和关系保持为不解析的 OOXML；导出后不刷新透视缓存。' },
  { key: 'externalLinks', label: '外链', patterns: [/\/externalLinks?\//i, /externalLink/i], note: '外链部件保持；不访问、不刷新外部地址。' },
  { key: 'definedNames', label: '名称/名称范围', patterns: [/workbook\.xml$/i, /definedName/i], note: '工作簿名称保持；引用目标不重写。' },
  { key: 'dataValidation', label: '数据验证', patterns: [/\/worksheets\/[^/]+\.xml$/i, /dataValidations?/i], note: '验证规则保持；被替换单元格不重新计算验证结果。' },
  { key: 'conditionalFormatting', label: '条件格式', patterns: [/\/worksheets\/[^/]+\.xml$/i, /conditionalFormatting/i], note: '条件格式保持；不执行视觉重算。' },
  { key: 'smartArt', label: 'SmartArt/图示', patterns: [/\/diagrams?\//i, /smartArt/i, /diagram/i], note: '图示部件保持为不解析的 OOXML。' },
  { key: 'embeddedObjects', label: '嵌入对象/控件', patterns: [/\/embeddings?\//i, /\/activeX\//i, /oleObject/i, /ctrlProps/i], note: '嵌入对象保持；不执行、不反序列化。' }
]);

function xmlAttribute(attributes, name) {
  const match = String(attributes || '').match(new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}=(['"])([\\s\\S]*?)\\1`, 'i'));
  return match ? match[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '';
}

function relationshipSourceName(name) {
  const normalized = path.posix.normalize(String(name || '').replace(/\\/g, '/'));
  if (normalized === '_rels/.rels') return '';
  const marker = '/_rels/';
  const index = normalized.indexOf(marker);
  if (index < 0 || !normalized.endsWith('.rels')) return '';
  return `${normalized.slice(0, index)}${normalized.slice(index + marker.length, -5)}`;
}

function resolveRelationshipTarget(source, target) {
  const value = String(target || '').replace(/\\/g, '/');
  if (!value || /^([a-z]+:)?\/\//i.test(value) || value.startsWith('#')) return { external: true, resolved: value };
  const base = source ? path.posix.dirname(source) : '';
  const resolved = path.posix.normalize(path.posix.join(base, value)).replace(/^\.\//u, '');
  return { external: false, resolved, traversal: resolved === '..' || resolved.startsWith('../') || resolved.includes('/../') };
}

async function inspectRelationships(zip) {
  const relationshipEntries = Object.keys(zip.files).filter((name) => /(^|\/)\.?_rels\/[^/]+\.rels$|^_rels\/\.rels$/i.test(name));
  const evidence = [];
  const anomalies = [];
  let external = 0;
  let relationships = 0;
  const seenIds = new Set();
  for (const name of relationshipEntries.sort()) {
    const xml = await zip.file(name)?.async('string');
    if (!xml) continue;
    const source = relationshipSourceName(name);
    for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const attrs = match[1];
      const id = xmlAttribute(attrs, 'Id');
      const target = xmlAttribute(attrs, 'Target');
      const targetMode = xmlAttribute(attrs, 'TargetMode');
      relationships += 1;
      if (!id || seenIds.has(`${name}:${id}`)) anomalies.push({ type: 'duplicate-or-missing-id', part: name, id });
      seenIds.add(`${name}:${id}`);
      const resolved = resolveRelationshipTarget(source, target);
      const isExternal = resolved.external || /^external$/i.test(targetMode);
      if (isExternal) external += 1;
      if (resolved.traversal) anomalies.push({ type: 'path-traversal-target', part: name, target });
      if (!isExternal && resolved.resolved && !zip.files[resolved.resolved]) anomalies.push({ type: 'missing-target', part: name, target, resolved: resolved.resolved });
      evidence.push({ part: name, source, id, target, targetMode: targetMode || 'Internal', external: isExternal, resolved: resolved.resolved || null });
    }
  }
  return { relationshipParts: relationshipEntries.length, relationships, external, anomalies, evidence: evidence.slice(0, 80) };
}

async function inspectOfficeLongTail(zip, extension = '') {
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  const contents = new Map();
  const read = async (name) => {
    if (!contents.has(name)) contents.set(name, await zip.file(name)?.async('string') || '');
    return contents.get(name);
  };
  const relationships = await inspectRelationships(zip);
  const items = [];
  for (const feature of FEATURE_DEFINITIONS) {
    const evidence = [];
    for (const name of names) {
      const nameHit = feature.patterns.some((pattern) => pattern.test(name));
      if (nameHit) evidence.push(name);
      if (feature.key === 'definedNames' || feature.key === 'dataValidation' || feature.key === 'conditionalFormatting' || feature.key === 'smartArt' || feature.key === 'embeddedObjects') {
        const xml = await read(name);
        if (xml && feature.patterns.slice(1).some((pattern) => pattern.test(xml)) && !evidence.includes(name)) evidence.push(name);
      }
    }
    const detected = evidence.length > 0;
    let status = detected ? 'preserved' : 'absent';
    let action = detected ? 'preserve-opaque-part' : 'none';
    if (detected && ['pivotTables', 'externalLinks', 'smartArt', 'embeddedObjects'].includes(feature.key)) {
      status = 'degraded';
      action = 'preserve-but-do-not-recalculate-or-execute';
    }
    items.push({ feature: feature.key, label: feature.label, detected, count: evidence.length, evidence: evidence.slice(0, 30), status, action, note: feature.note });
  }
  const relStatus = relationships.anomalies.length ? 'degraded' : relationships.relationships ? 'preserved' : 'absent';
  items.push({
    feature: 'relationships', label: '关系包', detected: relationships.relationships > 0, count: relationships.relationships,
    evidence: relationships.evidence.slice(0, 30), status: relStatus,
    action: relationships.anomalies.length ? 'preserve-bytes-and-report-anomaly' : 'preserve-relationships',
    note: relationships.anomalies.length ? `发现 ${relationships.anomalies.length} 个关系异常；未自动修复。` : '关系目标和 TargetMode 已逐项盘点。'
  });
  if (relationships.external && !items.find((item) => item.feature === 'externalLinks')?.detected) {
    const item = items.find((value) => value.feature === 'externalLinks');
    item.detected = true;
    item.count = relationships.external;
    item.evidence = relationships.evidence.filter((value) => value.external).slice(0, 30);
    item.status = 'degraded';
    item.action = 'preserve-but-do-not-fetch-external-target';
  }
  const degraded = items.filter((item) => item.status === 'degraded');
  return {
    schema: 'VEILFORGE_OFFICE_LONG_TAIL_V1',
    extension: String(extension || '').toLowerCase(),
    packageParts: names.length,
    detectedFeatures: items.filter((item) => item.detected).map((item) => item.feature),
    degradedFeatures: degraded.map((item) => item.feature),
    degradationCount: degraded.length,
    relationshipSummary: { parts: relationships.relationshipParts, relationships: relationships.relationships, external: relationships.external, anomalies: relationships.anomalies },
    items
  };
}

module.exports = { inspectOfficeLongTail, inspectRelationships, FEATURE_DEFINITIONS };
