import assert from "node:assert/strict";
import test from "node:test";
import { digestEntries } from "../packages/backend/src/editorial/financing-digests.ts";
import { financingBatchProtocol, financingText, validateFinancing, validateTransactions } from "../packages/backend/src/editorial/financing-extraction.ts";

test("only institution names with supporting quotes in this report are published", () => {
  const text = "星辰完成近亿元A轮融资。此轮由蓝海创投领投。";
  const input = { company:"星辰", evidence:"星辰完成近亿元A轮融资。", kind:"company_round" as const,
    amountText:"近亿元", valuationText:"5亿元", status:"closed" as const, amountBasis:"round" as const,
    investors:[{name:"蓝海创投",quote:"此轮由蓝海创投领投。"}, {name:"蓝海创投",quote:"蓝海创投领投"},
      {name:"另一机构",quote:"此轮由蓝海创投领投。"}, {name:"上一轮机构",quote:"上一轮机构参与本轮"}] };
  const {claim,investorEvidence} = validateFinancing({id:1,text},input);
  assert.deepEqual(claim?.investors, ["蓝海创投"]);
  assert.equal(investorEvidence.length, 1);
  assert.equal(claim?.valuationText,null);
  assert.equal(validateFinancing({id:2,text:"另一篇材料"},input).claim,null);
  assert.equal(validateFinancing({id:3,text},null).claim,null);
});
test("financing text retains investor attribution from deep in a long original", () => {
  assert.match(financingText("标题",null,"开头。".repeat(1500)+"此轮由蓝海领投。"),/蓝海领投/);
});

test("Chinese layout spaces are tolerated and the retained quote is from the original", () => {
  const text = "图灵科技 （ Turing ） 完成融资，由 蓝海 创投领投。";
  const {claim,investorEvidence} = validateFinancing({id:1,text}, {
    company: "图灵科技", evidence: "图灵科技（Turing）完成融资", investors: [{ name: "蓝海创投", quote: "由蓝海创投领投" }],
    kind: "company_round", status: "announced", amountBasis: "unknown",
  });
  assert.equal(claim?.evidence, "图灵科技 （ Turing ） 完成融资");
  assert.deepEqual(investorEvidence,[{name:"蓝海创投",quote:"由 蓝海 创投领投"}]);
});
test("an HTML-encoded source keeps a literal attribution for a readable investor name", () => {
  const text = "Atlas raised with Sprout &#38; Oak at the company&#8217;s first close.";
  const {claim,investorEvidence} = validateFinancing({id:1,text},{
    company:"Atlas", evidence:"Atlas raised with Sprout & Oak", kind:"company_round", status:"closed",
    amountBasis:"unknown", investors:[{name:"Sprout & Oak",quote:"Sprout & Oak at the company’s first close"}],
  });
  assert.deepEqual(claim?.investors,["Sprout & Oak"]);
  assert.equal(investorEvidence[0]?.quote,"Sprout &#38; Oak at the company&#8217;s first close");
});
test("a lead investor at the end of a long feed excerpt reaches extraction", () => {
  const excerpt = "Introduction. ".repeat(450) + "FirstMark is excited to lead Fragment’s Series A.";
  assert.match(financingText("Our investment in Fragment",excerpt,null),/FirstMark is excited to lead/);
});

test("a roundup claim can only use fields from its own named transaction passage", () => {
  const first = "甲公司获50亿美元投资。";
  const second = "镁伽科技完成近2亿美元E轮融资，乙基金领投。";
  const source = { id: 1, text: first + second };
  const claim = { company: "甲公司", passage: first, evidence: first, kind: "company_round", amountText: "近2亿美元",
    round: "E轮", investors: [{ name: "乙基金", quote: "乙基金领投" }] };
  const { claims, review } = validateTransactions(source, [claim, claim,
    { ...claim, company: "镁伽科技" }, { ...claim, evidence: second }]);
  assert.equal(claims.length, 1);
  assert.equal(review.rejected, 2);
  assert.equal(claims[0]?.amountText, null);
  assert.equal(claims[0]?.round, null);
  assert.deepEqual(claims[0]?.investors, []);
});

test("roundup input preserves named recipients deep inside the original report", () => {
  const original = "本周市场简讯。".repeat(1250) + "本周海外榜首是 Isomorphic Labs。";
  assert.match(financingText("全球投融资周报", null, original, true), /Isomorphic Labs/);
});

test("stored answers without a passage use the named evidence and its immediately adjacent investor list", () => {
  const evidence = "甲科技 完成E轮融资，融资金额近2亿美元";
  const investors = "投资方：甲基金 乙创投";
  const source = { id: 1, text: evidence + " " + investors + "。丙公司获得50亿美元融资，投资方：丙基金。" };
  const claim = { company: "甲科技", evidence, kind: "company_round", round: "E轮", amountText: "近2亿美元",
    investors: [{name:"甲基金",quote:investors}, {name:"丙基金",quote:"投资方：丙基金"}] };
  const result = validateTransactions(source, [claim]);
  assert.equal(result.claims[0]?.amountText, "近2亿美元");
  assert.deepEqual(result.claims[0]?.investors, ["甲基金"]);
  assert.equal(validateTransactions(source,[{...claim,amountText:"50亿美元"}]).claims[0]?.amountText,null);
});

test("one announcement retains two named rounds, with amounts and investors only where allocated", () => {
  const evidence = "星辰完成A轮和B轮融资，合计5000万美元。";
  const terms = "B轮融资3000万美元，由乙基金领投。";
  const passage = evidence + terms;
  const source = { id: 1, text: passage, format: "rounds" as const };
  const deal = { company: "星辰", evidence, passage, amountText: "5000万美元", currency: "USD", kind: "company_round",
    rounds: [
      { round: "A轮", amountText: "5000万美元", terms: evidence, investors: [{name:"乙基金",quote:"乙基金领投"}] },
      { round: "B轮", amountText: "3000万美元", currency: "USD", terms, investors: [{name:"乙基金",quote:"乙基金领投"}] },
    ] };
  const { claims } = validateTransactions(source, [deal]);
  assert.deepEqual(claims.map(c => [c.round, c.amountText, c.currency, c.investors, c.evidence]), [
    ["A轮", null, null, [], evidence], ["B轮", "3000万美元", "USD", ["乙基金"], evidence],
  ]);
  const flat = validateTransactions(source, [{ ...deal, rounds: undefined, round: "A轮", amountBasis: "round" }]);
  assert.deepEqual(flat.claims.map(c => [c.round, c.amountText]), [["A轮", null], ["B轮", null]]);
});

test("unallocated multi-round totals stay cumulative and a single deal cannot be relabeled as multiple rounds", () => {
  const evidence = "甲公司连续完成两轮融资，合计近亿元人民币。";
  const entry = { company: "甲公司", kind: "company_round", evidence, amountText: "近亿元人民币", currency: "CNY", rounds: [] };
  const source = { id: 1, format: "rounds" as const, text: evidence };
  const claim = validateTransactions(source, [entry]).claims[0];
  assert.equal(claim?.amountBasis, "cumulative");
  assert.equal(claim?.round, null);
  assert.equal(claim?.amountText, "近亿元人民币");
  assert.equal(claim?.recordType, "aggregate_disclosure");

  const oneRound = "甲公司A轮融资近亿元人民币。";
  const original = validateTransactions({ ...source, text: oneRound }, [{ ...entry, evidence: oneRound, amountBasis: "round", round: "A轮" }]).claims[0];
  assert.equal(original?.recordType, undefined);
  assert.equal(original?.round, "A轮");
});

test("stored batches keep their original systems and receipt versions", () => {
  const source = { id: 1, text: "original material" };
  assert.equal(financingBatchProtocol(source).version, "financing-investors-v1");
  const v2 = financingBatchProtocol({ ...source, format: "transactions" });
  const v3 = financingBatchProtocol({ ...source, format: "rounds" });
  assert.equal(v2.version, "financing-transactions-v2");
  assert.equal(v3.version, "financing-transactions-v3");
  assert.ok(v3.system.startsWith(v2.system));
  assert.doesNotMatch(v2.system, /rounds array/);
});


test("English possessive apostrophes retain literal evidence offsets and cannot cross a quote boundary", () => {
  const candidate = (evidence:string) => ({company:"Embo",kind:"company_round",evidence,investors:[{name:"a16z",quote:evidence}]});
  for (const [printed,quoted] of [["&#8217;","'"],["&#x2019;","'"],["’","'"],["'","’"]]) {
    const sentence="a16z leads Embo"+printed+"s round";
    const {claims}=validateTransactions({id:1,text:"📰 Intro. "+sentence+". Next."},[candidate("a16z leads Embo"+quoted+"s round")]);
    assert.equal(claims[0]?.evidence,sentence);
    assert.deepEqual(claims[0]?.investors,["a16z"]);
  }
  for (const [printed,quoted] of [[" ’s","'s"],["’ s","'s"],["’s"," 's"],[" ‘fund’"," 'fund'"],["s","'s"]]) {
    assert.deepEqual(validateTransactions({id:1,text:"a16z leads Embo"+printed+" round"},[candidate("a16z leads Embo"+quoted+" round")]).claims,[]);
  }
});

test("a named digest section supplies explicit terms for each round after the short announcement", () => {
  const evidence = "明视脑机近期接连完成两轮融资，累计融资总额已超5亿元。";
  const plus = "本次 Pre-A+ 轮融资由甲基金领投";
  const pre = "Pre-A 轮融资由乙基金领投";
  const first = "【明视脑机宣布完成两轮融资】";
  const other = "【邻企完成B轮融资】";
  const text = first + evidence + plus + "；" + pre + "。" + other + "B轮融资由丙基金领投。";
  const material = {id:1,format:"rounds" as const,text,digestEntries:[
    {heading:"明视脑机宣布完成两轮融资"},{heading:"邻企完成B轮融资"}]};
  const deal = {company:"明视脑机",evidence,kind:"company_round",amountText:"超5亿元",currency:"CNY",
    // This receipt starts inside the headline and has no usable full-body passage.
    passage:first.slice(1) + evidence + plus + "；" + pre,
    rounds:[{round:"Pre-A+ 轮",amountText:"超5亿元",terms:plus,investors:[{name:"甲基金",quote:plus}]},
      {round:"Pre-A 轮",terms:pre,investors:[{name:"乙基金",quote:pre},{name:"丙基金",quote:"B轮融资由丙基金领投"}]},
      {round:"B轮",terms:"B轮融资由丙基金领投"}]};
  const fields=(rows:ReturnType<typeof validateTransactions>["claims"])=>rows.map(c=>[c.round,c.amountText,c.investors]);
  assert.deepEqual(fields(validateTransactions(material,[deal]).claims),[
    ["Pre-A+ 轮",null,["甲基金"]],["Pre-A 轮",null,["乙基金"]]]);
  assert.deepEqual(fields(validateTransactions(material,[{...deal,rounds:[],passage:undefined}]).claims),[
    ["Pre-A+ 轮",null,[]],["Pre-A 轮",null,[]]]);
  for(const unrelated of ["去年", "另据报道，邻企", "正在洽谈的下一笔"]) {
    const unsafe = {...material,text:first + evidence + unrelated + plus + "；" + pre + "。" + other};
    const claims = validateTransactions(unsafe,[{...deal,passage:undefined}]).claims;
    assert.deepEqual(claims.map(c=>[c.round,c.amountBasis,c.recordType]),[[null,"cumulative","aggregate_disclosure"]]);
  }
});

test("numbered series and historical comparisons do not announce another current round", () => {
  for(const stage of ["A3 轮","C2轮","Pre-A2 轮","第三轮"]) {
    const evidence = "今日甲科技完成" + stage + "融资。";
    const deal={company:"甲科技",kind:"company_round",round:stage,evidence};
    const rows=validateTransactions({id:1,format:"rounds",text:evidence},[deal]).claims;
    assert.deepEqual(rows.map(c=>[c.round,c.recordType]),[[stage,undefined]]);
  }
  const compared="白犀牛宣布完成C2轮融资，C轮融资金额累计达到1亿美元。";
  const rows=validateTransactions({id:1,text:compared,format:"rounds"},[{company:"白犀牛",kind:"company_round",evidence:compared,
    round:"C2轮",amountText:"1亿美元",amountBasis:"cumulative"}]).claims;
  assert.deepEqual(rows.map(c=>[c.round,c.amountBasis,c.recordType]),[["C2轮","cumulative",undefined]]);
  const past="甲科技完成C轮融资。去年甲科技完成A轮和B轮融资。";
  assert.deepEqual(validateTransactions({id:1,text:past,format:"rounds"},
    [{company:"甲科技",kind:"company_round",round:"C轮",evidence:past}]).claims.map(c=>c.round),["C轮"]);
  const historicalStages = {company:"甲科技",kind:"company_round",evidence:past,rounds:[{round:"C轮"},{round:"A轮"},{round:"B轮"}]};
  assert.deepEqual(validateTransactions({id:1,text:past,format:"rounds"},[historicalStages]).claims.map(c=>c.round),["C轮"]);
});

test("a full heading and a shortened transaction subject must agree on recipient, round and amount", () => {
  const heading="TypeSafe AI完成8.7亿美元A轮融资";
  const evidence="TypeSafe宣布完成8.7亿美元A轮融资，a16z领投";
  const text="【"+heading+"】AI公司TypeSafe AI开发了新模型。当地时间10月9日，"+evidence+"。";
  const deal={company:"TypeSafe AI",kind:"company_round",evidence,passage:evidence,round:"A轮",amountText:"8.7亿美元",
    investors:[{name:"a16z",quote:"a16z领投"}]};
  const material={id:1,text,format:"rounds" as const,digestEntries:[{heading}]};
  const rows=validateTransactions(material,[deal]).claims;
  assert.equal(rows.length,1);
  assert.ok(rows[0]?.evidence.includes("TypeSafe AI") && text.includes(rows[0].evidence));
  assert.deepEqual(rows[0]?.investors,["a16z"]);
  assert.deepEqual(validateTransactions(material,[{...deal,round:"B轮"}]).claims,[]);
  assert.deepEqual(validateTransactions({...material,text:text.replace(evidence,"TypeSafe Labs"+evidence.slice(8))},
    [{...deal,evidence:"TypeSafe Labs"+evidence.slice(8)}]).claims,[]);
});

test("a jointly participating list binds only to the named financing and confirmed role", () => {
  const heading="原子矩阵完成B轮融资";
  const evidence="量子计算公司原子矩阵近日宣布完成数亿元B轮融资";
  const role="本轮融资由杭州产投、博世创投等机构共同参与";
  const neg="本轮融资由未实投、顾问方等机构共同参与";
  const unrelated="技术交流会由合作方、路演方等机构共同参与";
  const text="【"+heading+"】"+evidence+"。"+role+"。拟议方案披露，"+neg+"。"+unrelated+"。";
  const rows=validateTransactions({id:1,text,format:"rounds",digestEntries:[{heading}]},[
    {company:"原子矩阵",kind:"company_round",round:"B轮",evidence,investors:[
      {name:"杭州产投",quote:role},{name:"博世创投",quote:role},{name:"未实投",quote:neg},
      {name:"路演方",quote:unrelated}]}]).claims;
  assert.deepEqual(rows[0]?.investors,["杭州产投","博世创投"]);
});

test("a single financing section or printed card is recognized only when requested", () => {
  for (const text of ["【甲科技完成融资】甲科技完成A轮和B轮融资。", "甲科技 🇨🇳 国内 近亿元人民币 📍 B轮 📅 10-10"]) {
    assert.equal(digestEntries("科技早报",text,null).length,0);
    assert.equal(digestEntries("科技早报",text,null,true).length,1);
  }
  assert.deepEqual(digestEntries("科技早报","投资市场热议融资环境",null,true),[]);
});
