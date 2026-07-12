// Built-in synthetic benchmark - a small, deterministic, offline dataset so `chitta bench`
// (and CI) runs with ZERO downloads. It is hand-built to exercise all five LongMemEval-style
// categories, including the two Chitta was built for: a job change + a move (knowledge-update
// → the LATEST value must win) and before/after ordering (temporal). Each history item is one
// stored record; `evidenceIds` are the records that actually contain each answer. Typed
// relations are supplied on the items that assert a single-valued fact, so the benchmark
// exercises the contradiction/supersession path (a fair comparison to LLM-extraction systems).

import type { BenchmarkDataset } from "./types"

export const syntheticDataset: BenchmarkDataset = {
  name: "synthetic",
  cases: [
    {
      id: "alex-life",
      history: [
        {
          id: "s1",
          timestamp: "2024-01-10",
          text: "Alex started a new job as a data scientist at Meta. Alex lives in Berlin.",
          entities: [{ name: "Alex", type: "PERSON" }, { name: "Meta", type: "ORG" }, { name: "Berlin", type: "PLACE" }],
          relations: [
            { from: "Alex", to: "Meta", type: "works_at" },
            { from: "Alex", to: "Berlin", type: "lives_in" },
          ],
        },
        {
          id: "s2",
          timestamp: "2024-03-15",
          text: "Alex adopted a dog named Rex. Alex enjoys rock climbing on weekends.",
          entities: [{ name: "Alex", type: "PERSON" }, { name: "Rex", type: "PERSON" }],
        },
        {
          id: "s3",
          timestamp: "2024-06-20",
          text: "Alex left Meta and now works at OpenAI, still as a data scientist.",
          entities: [{ name: "Alex", type: "PERSON" }, { name: "OpenAI", type: "ORG" }],
          relations: [{ from: "Alex", to: "OpenAI", type: "works_at" }], // supersedes Meta
        },
        {
          id: "s4",
          timestamp: "2024-09-05",
          text: "Alex relocated from Berlin to Munich for the new role.",
          entities: [{ name: "Alex", type: "PERSON" }, { name: "Munich", type: "PLACE" }],
          relations: [{ from: "Alex", to: "Munich", type: "lives_in" }], // supersedes Berlin
        },
        {
          id: "s5",
          timestamp: "2024-11-11",
          text: "Alex's sister Maria visited from Madrid. Maria works as a doctor.",
          entities: [{ name: "Maria", type: "PERSON" }, { name: "Madrid", type: "PLACE" }],
        },
      ],
      questions: [
        { id: "q1", question: "What is the name of Alex's dog?", answer: "Rex", category: "single-hop", evidenceIds: ["s2"] },
        { id: "q2", question: "What is the profession of Alex's sister Maria?", answer: "A doctor", category: "single-hop", evidenceIds: ["s5"] },
        { id: "q3", question: "Where does Alex work now?", answer: "OpenAI", category: "knowledge-update", evidenceIds: ["s3"] },
        { id: "q4", question: "Which city does Alex currently live in?", answer: "Munich", category: "knowledge-update", evidenceIds: ["s4"] },
        { id: "q5", question: "Where did Alex work before joining OpenAI?", answer: "Meta", category: "temporal", evidenceIds: ["s1", "s3"] },
        { id: "q6", question: "Did Alex adopt Rex before or after moving to Munich?", answer: "Before", category: "temporal", evidenceIds: ["s2", "s4"] },
        { id: "q7", question: "What is the profession of Alex's sibling who visited from Madrid?", answer: "A doctor", category: "multi-hop", evidenceIds: ["s5"] },
        { id: "q8", question: "What is Alex's favorite color?", answer: "Not stated", category: "abstention", evidenceIds: [], abstain: true },
      ],
    },
    {
      id: "acme-project",
      history: [
        {
          id: "p1",
          timestamp: "2025-02-01",
          text: "Project Orion is led by Priya. It targets a Q3 launch.",
          entities: [{ name: "Project Orion", type: "PRODUCT" }, { name: "Priya", type: "PERSON" }],
          relations: [{ from: "Project Orion", to: "Priya", type: "led_by" }],
        },
        {
          id: "p2",
          timestamp: "2025-04-12",
          text: "Leadership of Project Orion moved from Priya to Sam after the reorg.",
          entities: [{ name: "Project Orion", type: "PRODUCT" }, { name: "Sam", type: "PERSON" }],
          relations: [{ from: "Project Orion", to: "Sam", type: "led_by" }], // supersedes Priya
        },
        { id: "p3", timestamp: "2025-05-03", text: "The Project Orion launch slipped from Q3 to Q4 due to a security review." },
      ],
      questions: [
        { id: "q9", question: "Who currently leads Project Orion?", answer: "Sam", category: "knowledge-update", evidenceIds: ["p2"] },
        { id: "q10", question: "When is Project Orion now expected to launch?", answer: "Q4", category: "knowledge-update", evidenceIds: ["p3"] },
        { id: "q11", question: "Why did the Project Orion launch slip?", answer: "A security review", category: "single-hop", evidenceIds: ["p3"] },
      ],
    },
  ],
}
