export const DEMO_DOCUMENT = Object.freeze({
  name: '采购业务说明 · 本地演示.txt',
  extension: '.txt',
  text: `采购业务说明（全部为虚构演示数据）

甲方：青岚设备有限公司
乙方：云川供应链有限公司
甲方联系人：张华
乙方联系人：李宁
联系电话：13812345678
电子邮箱：zhang.hua@example.com
银行卡号：4532015112830366
联系地址：杭州市滨江区科创路88号
服务器地址：192.168.10.24

项目名称：流光计划
合同金额：80万元；签订日期：2026年10月30日。
设备到货后，甲方应在30日内向乙方付款。

本样例只用于本机脱敏流程演示。`
});

export const WORKFLOW_STAGES = Object.freeze(['import', 'review', 'export']);

export function workflowSteps(stage = 'import') {
  const current = stage === 'complete' ? WORKFLOW_STAGES.length : Math.max(0, WORKFLOW_STAGES.indexOf(stage));
  return WORKFLOW_STAGES.map((name, index) => ({
    name,
    state: stage === 'complete' || index < current ? 'done' : index === current ? 'current' : 'pending'
  }));
}

export function demoDocumentResult() {
  const bytes = new TextEncoder().encode(DEMO_DOCUMENT.text).length;
  return {
    ...DEMO_DOCUMENT,
    sourceBytes: bytes,
    characters: DEMO_DOCUMENT.text.length
  };
}
