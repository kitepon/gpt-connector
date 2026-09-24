import assert from "node:assert/strict";
import test from "node:test";
import { identifyGrokModules } from "../src/grok-asset-discovery.js";

const api = 'e.s(["appDeployerApi",0,x,"chatApi",0,y,"modelsApi",0,z],2569170)';
const stores = [
  'e.s(["useChatPageStore",()=>s,"useDraftText",()=>t],458272)',
  'e.s(["useModesStore",0,s],8647679)',
  '},9900502,e=>{"use strict";e.s(["useResponseStore",()=>s])',
  'e.s(["useConversationStore",()=>s],419746)',
].join(";");

test("Grokのruntime moduleを役割ごとに一意に検出する", () => {
  assert.deepEqual(identifyGrokModules([api, stores]), {
    api: 2569170, responseStore: 9900502, conversationStore: 419746,
    modesStore: 8647679, chatPageStore: 458272,
  });
});

test("欠落または曖昧なGrok runtimeは送信前に拒否する", () => {
  assert.throws(() => identifyGrokModules([api]), /一意に検出/u);
  assert.throws(() => identifyGrokModules([api, stores, api.replace("2569170", "1234567")]), /一意に検出/u);
});
