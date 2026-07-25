import { describe, expect, it } from "vitest";
import {
  applyProjectStoreBootstrapSchema,
  applyProjectStoreSchemaMigrationSteps,
  backfillProjectStoreOrchestrationTaskProjectPath,
  backfillProjectStoreThreadLastReadAt,
  ensureProjectStoreColumn,
  ensureProjectStoreColumnGroup,
  ensureProjectStoreIndex,
  migrateProjectStorePermissionModeDefaultsToWorkspace,
  PROJECT_STORE_DATA_MIGRATION_SQL,
  PROJECT_STORE_MIGRATION_COLUMN_GROUPS,
  PROJECT_STORE_MIGRATION_INDEX_SQL,
  PROJECT_STORE_SCHEMA_MIGRATION_STEPS_AFTER_ORCHESTRATION_BACKFILL_BEFORE_PLANNER_REPAIR,
  PROJECT_STORE_SCHEMA_MIGRATION_STEPS_AFTER_PLANNER_REPAIR,
  PROJECT_STORE_SCHEMA_MIGRATION_STEPS_BEFORE_ORCHESTRATION_BACKFILL,
  PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL,
  repairProjectStorePlannerPlanWorkflowStates,
  replaceProjectStoreLegacyModelId,
} from "./projectStoreSchema";

describe("project store schema bootstrap", () => {
  it("keeps table bootstrap SQL in the schema module without imperative migrations", () => {
    expect(PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL).toContain("PRAGMA journal_mode = WAL;");
    expect(PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL).toContain("PRAGMA busy_timeout = 5000;");
    expect(PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL).not.toMatch(/\b(?:ALTER TABLE|UPDATE|INSERT)\b/i);
    expect(schemaNames(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)).toEqual([
      "settings",
      "threads",
      "thread_worktrees",
      "messages",
      "subagent_runs",
      "subagent_spawn_edges",
      "subagent_run_events",
      "subagent_mailbox_events",
      "subagent_parent_mailbox_events",
      "subagent_prompt_snapshots",
      "subagent_tool_scope_snapshots",
      "subagent_wait_barriers",
      "subagent_maturity_evidence",
      "subagent_batch_jobs",
      "subagent_batch_result_reports",
      "message_voice_states",
      "runs",
      "run_diagnostic_payloads",
      "context_usage_snapshots",
      "thread_goals",
      "thread_wake_continuations",
      "permission_audit",
      "permission_grants",
      "planner_plan_artifacts",
      "planner_decision_questions",
      "project_boards",
      "project_board_charters",
      "project_board_cards",
      "project_board_sources",
      "project_board_questions",
      "project_board_events",
      "project_board_synthesis_proposals",
      "project_board_synthesis_runs",
      "project_board_execution_artifacts",
      "plugin_settings",
      "plugin_trust",
      "automation_folders",
      "automation_thread_folders",
      "automation_schedules",
      "automation_schedule_exceptions",
      "orchestration_tasks",
      "orchestration_runs",
      "workflow_agent_folders",
      "workflow_agent_threads",
      "workflow_graph_snapshots",
      "workflow_exploration_traces",
      "workflow_versions",
      "workflow_revisions",
      "workflow_discovery_questions",
      "workflow_artifacts",
      "workflow_runs",
      "callable_workflow_tasks",
      "workflow_run_events",
      "workflow_model_calls",
      "artifact_drafts",
      "artifact_draft_events",
    ]);
    expect(schemaNames(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+([a-z_]+)/g)).toHaveLength(68);
    expect(PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL).not.toMatch(/CREATE INDEX[^\n]+operation_key/i);
  });

  it("applies the exported bootstrap SQL through the database exec boundary", () => {
    const calls: string[] = [];
    applyProjectStoreBootstrapSchema({ exec: (sql: string) => calls.push(sql) } as never);
    expect(calls).toEqual([PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL]);
  });

  it("adds missing migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumn(fakeSchemaDb(["id", "title"], calls), "threads", "last_read_at", "TEXT");

    expect(calls).toEqual(["PRAGMA table_info(threads)", "ALTER TABLE threads ADD COLUMN last_read_at TEXT"]);
  });

  it("does not add migration columns that already exist", () => {
    const calls: string[] = [];
    ensureProjectStoreColumn(fakeSchemaDb(["id", "last_read_at"], calls), "threads", "last_read_at", "TEXT");

    expect(calls).toEqual(["PRAGMA table_info(threads)"]);
  });

  it("keeps the core thread and subagent migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.coreThreadSubagent).toEqual([
      ["threads", "last_read_at", "TEXT"],
      ["threads", "collaboration_mode", "TEXT NOT NULL DEFAULT 'agent'"],
      ["threads", "archived_at", "TEXT"],
      ["threads", "pinned", "INTEGER NOT NULL DEFAULT 0"],
      ["threads", "workflow_recording_json", "TEXT"],
      ["threads", "memory_enabled", "INTEGER NOT NULL DEFAULT 0"],
      ["threads", "kind", "TEXT NOT NULL DEFAULT 'chat'"],
      ["threads", "parent_thread_id", "TEXT"],
      ["threads", "parent_message_id", "TEXT"],
      ["threads", "parent_run_id", "TEXT"],
      ["threads", "subagent_run_id", "TEXT"],
      ["threads", "canonical_task_path", "TEXT"],
      ["threads", "child_order", "INTEGER"],
      ["threads", "collapsed_by_default", "INTEGER NOT NULL DEFAULT 0"],
      ["threads", "child_status", "TEXT"],
      ["subagent_runs", "role_profile_snapshot_json", "TEXT"],
      ["subagent_runs", "effective_role_snapshot_json", "TEXT"],
      ["subagent_runs", "capacity_lease_snapshot_json", "TEXT"],
      ["subagent_runs", "symphony_launch_contract_json", "TEXT"],
      ["subagent_runs", "symphony_mutation_lease_json", "TEXT"],
      ["subagent_parent_mailbox_events", "parent_message_id", "TEXT"],
      ["subagent_wait_barriers", "quorum_threshold", "INTEGER"],
      ["subagent_wait_barriers", "owner_kind", "TEXT"],
      ["subagent_wait_barriers", "owner_id", "TEXT"],
    ]);
  });

  it("keeps runtime support migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.runtimeSupport).toEqual([
      ["runs", "diagnostics_json", "TEXT"],
      ["context_usage_snapshots", "model_id", "TEXT"],
      ["message_voice_states", "last_audio_path", "TEXT"],
      ["plugin_trust", "fingerprint", "TEXT"],
      ["permission_audit", "decision_source", "TEXT"],
      ["permission_audit", "grant_id", "TEXT"],
    ]);
  });

  it("keeps project-board card migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.projectBoardCards).toEqual([
      ["project_board_cards", "orchestration_task_id", "TEXT"],
      ["project_board_cards", "candidate_status", "TEXT NOT NULL DEFAULT 'ready_to_create'"],
      ["project_board_cards", "source_refs_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_cards", "clarification_questions_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_cards", "clarification_suggestions_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_cards", "clarification_answers_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_cards", "clarification_decisions_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_cards", "run_feedback_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_cards", "execution_thread_id", "TEXT"],
      ["project_board_cards", "execution_session_policy", "TEXT NOT NULL DEFAULT 'reuse_card_session'"],
      ["project_board_cards", "proof_review_json", "TEXT"],
      ["project_board_cards", "split_outcome_json", "TEXT"],
      ["project_board_cards", "objective_provenance_json", "TEXT"],
      ["project_board_cards", "ui_mock_role", "TEXT"],
      ["project_board_cards", "requires_ui_mock_approval", "INTEGER NOT NULL DEFAULT 0"],
      ["project_board_cards", "user_touched_fields_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_cards", "user_touched_at", "TEXT"],
      ["project_board_cards", "pending_pi_update_json", "TEXT"],
    ]);
  });

  it("keeps project-board source metadata migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.projectBoardSourceMetadata).toEqual([
      ["project_board_charters", "project_summary_json", "TEXT"],
      ["project_board_sources", "excerpt", "TEXT"],
      ["project_board_sources", "source_key", "TEXT"],
      ["project_board_sources", "content_hash", "TEXT"],
      ["project_board_sources", "change_state", "TEXT"],
      ["project_board_sources", "byte_size", "INTEGER"],
      ["project_board_sources", "mtime", "TEXT"],
      ["project_board_sources", "classification_reason", "TEXT"],
      ["project_board_sources", "classified_by", "TEXT"],
      ["project_board_sources", "classification_confidence", "REAL"],
      ["project_board_sources", "authority_role", "TEXT"],
      ["project_board_sources", "include_in_synthesis", "INTEGER NOT NULL DEFAULT 1"],
    ]);
  });

  it("keeps project-board question and synthesis migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.projectBoardQuestionSynthesis).toEqual([
      ["project_board_questions", "suggested_answer", "TEXT"],
      ["project_board_questions", "suggestion_rationale", "TEXT"],
      ["project_board_questions", "suggestion_confidence", "TEXT"],
      ["project_board_questions", "suggestion_source_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_questions", "suggestion_context_fingerprint", "TEXT"],
      ["project_board_questions", "suggestion_generated_at", "TEXT"],
      ["project_board_questions", "suggestion_model", "TEXT"],
      ["project_board_questions", "suggestion_provider_error", "TEXT"],
      ["project_board_synthesis_proposals", "answers_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_synthesis_proposals", "review_report_json", "TEXT"],
      ["project_board_synthesis_runs", "progressive_records_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project_board_synthesis_runs", "planning_snapshots_json", "TEXT NOT NULL DEFAULT '[]'"],
    ]);
  });

  it("keeps project-board execution artifact migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.projectBoardExecutionArtifacts).toEqual([
      ["project_board_execution_artifacts", "source", "TEXT NOT NULL DEFAULT 'git'"],
    ]);
  });

  it("keeps automation and orchestration migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.automationOrchestration).toEqual([
      ["automation_schedules", "last_run_at", "TEXT"],
      ["automation_schedules", "target_version", "INTEGER"],
      ["automation_schedules", "created_target_version_id", "TEXT"],
      ["automation_schedules", "dedicated_thread_id", "TEXT"],
      ["automation_schedules", "run_limits_json", "TEXT"],
      ["automation_schedule_exceptions", "run_limits_json", "TEXT"],
      ["orchestration_tasks", "project_path", "TEXT"],
    ]);
  });

  it("keeps workflow run migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.workflowRuns).toEqual([
      ["workflow_artifacts", "workflow_thread_id", "TEXT"],
      ["workflow_agent_threads", "chat_thread_id", "TEXT"],
      ["workflow_agent_threads", "trace_mode", "TEXT NOT NULL DEFAULT 'production'"],
      ["workflow_run_events", "graph_node_id", "TEXT"],
      ["workflow_run_events", "graph_edge_id", "TEXT"],
      ["workflow_run_events", "item_key", "TEXT"],
      ["workflow_runs", "graph_snapshot_id", "TEXT"],
      ["workflow_runs", "provider_health_json", "TEXT"],
      ["workflow_runs", "retry_metadata_json", "TEXT"],
      ["workflow_runs", "recovery_context_json", "TEXT"],
    ]);
  });

  it("keeps workflow exploration trace migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.workflowExplorationTraces).toEqual([
      ["workflow_exploration_traces", "events_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["workflow_exploration_traces", "run_status", "TEXT NOT NULL DEFAULT 'succeeded'"],
      ["workflow_exploration_traces", "graph_snapshot_id", "TEXT"],
      ["workflow_exploration_traces", "latest_progress_json", "TEXT"],
      ["workflow_exploration_traces", "provider_health_json", "TEXT"],
      ["workflow_exploration_traces", "retry_metadata_json", "TEXT"],
      ["workflow_exploration_traces", "error_message", "TEXT"],
      ["workflow_exploration_traces", "updated_at", "TEXT"],
      ["workflow_exploration_traces", "completed_at", "TEXT"],
    ]);
  });

  it("keeps workflow model-call migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.workflowModelCalls).toEqual([
      ["workflow_model_calls", "graph_node_id", "TEXT"],
      ["workflow_model_calls", "graph_edge_id", "TEXT"],
      ["workflow_model_calls", "item_key", "TEXT"],
      ["workflow_model_calls", "cache_checkpoint_json", "TEXT"],
    ]);
  });

  it("keeps workflow discovery question migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.workflowDiscoveryQuestions).toEqual([
      ["workflow_discovery_questions", "provider", "TEXT"],
      ["workflow_discovery_questions", "revision_id", "TEXT"],
      ["workflow_discovery_questions", "provider_model", "TEXT"],
      ["workflow_discovery_questions", "policy_context_summary", "TEXT"],
      ["workflow_discovery_questions", "capability_search_json", "TEXT"],
      ["workflow_discovery_questions", "capability_descriptions_json", "TEXT"],
      ["workflow_discovery_questions", "blocked_reasons_json", "TEXT"],
      ["workflow_discovery_questions", "access_requests_json", "TEXT"],
      ["workflow_discovery_questions", "activity_events_json", "TEXT"],
    ]);
  });

  it("keeps planner and thread-goal migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.plannerThreadGoals).toEqual([
      ["planner_plan_artifacts", "diagrams_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["planner_plan_artifacts", "warnings_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["planner_plan_artifacts", "workflow_state", "TEXT NOT NULL DEFAULT 'draft'"],
      ["planner_plan_artifacts", "finalization_attempt_json", "TEXT"],
      ["planner_plan_artifacts", "durable_artifact_path", "TEXT"],
      ["planner_plan_artifacts", "durable_artifact_generated_at", "TEXT"],
      ["planner_plan_artifacts", "durable_artifact_validation_json", "TEXT"],
      ["thread_goals", "status_reason", "TEXT"],
      ["thread_goals", "completed_at", "TEXT"],
      ["thread_goals", "last_continued_at", "TEXT"],
      ["thread_goals", "provider_infra_failures", "INTEGER NOT NULL DEFAULT 0"],
    ]);
  });

  it("keeps final workflow discovery migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.workflowDiscoveryFinal).toEqual([
      ["workflow_discovery_questions", "cache_checkpoint_json", "TEXT"],
      ["workflow_discovery_questions", "graph_patch_json", "TEXT"],
    ]);
  });

  it("keeps thread wake continuation migration columns in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.threadWakeContinuations).toEqual([
      ["thread_wake_continuations", "operation_key", "TEXT"],
      ["thread_wake_continuations", "supersedes_wake_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["thread_wake_continuations", "resolved_at", "TEXT"],
      ["thread_wake_continuations", "resolution_reason", "TEXT"],
    ]);
  });

  it("applies migration column groups through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "coreThreadSubagent");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(
      PROJECT_STORE_MIGRATION_COLUMN_GROUPS.coreThreadSubagent.length,
    );
    expect(calls.slice(0, 2)).toEqual(["PRAGMA table_info(threads)", "ALTER TABLE threads ADD COLUMN last_read_at TEXT"]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(subagent_wait_barriers)",
      "ALTER TABLE subagent_wait_barriers ADD COLUMN owner_id TEXT",
    ]);
  });

  it("applies runtime support migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "runtimeSupport");

    expect(calls).toEqual([
      "PRAGMA table_info(runs)",
      "ALTER TABLE runs ADD COLUMN diagnostics_json TEXT",
      "PRAGMA table_info(context_usage_snapshots)",
      "ALTER TABLE context_usage_snapshots ADD COLUMN model_id TEXT",
      "PRAGMA table_info(message_voice_states)",
      "ALTER TABLE message_voice_states ADD COLUMN last_audio_path TEXT",
      "PRAGMA table_info(plugin_trust)",
      "ALTER TABLE plugin_trust ADD COLUMN fingerprint TEXT",
      "PRAGMA table_info(permission_audit)",
      "ALTER TABLE permission_audit ADD COLUMN decision_source TEXT",
      "PRAGMA table_info(permission_audit)",
      "ALTER TABLE permission_audit ADD COLUMN grant_id TEXT",
    ]);
  });

  it("applies project-board card migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "projectBoardCards");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(
      PROJECT_STORE_MIGRATION_COLUMN_GROUPS.projectBoardCards.length,
    );
    expect(calls.slice(0, 2)).toEqual([
      "PRAGMA table_info(project_board_cards)",
      "ALTER TABLE project_board_cards ADD COLUMN orchestration_task_id TEXT",
    ]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(project_board_cards)",
      "ALTER TABLE project_board_cards ADD COLUMN pending_pi_update_json TEXT",
    ]);
  });

  it("applies project-board source metadata migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "projectBoardSourceMetadata");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(
      PROJECT_STORE_MIGRATION_COLUMN_GROUPS.projectBoardSourceMetadata.length,
    );
    expect(calls.slice(0, 2)).toEqual([
      "PRAGMA table_info(project_board_charters)",
      "ALTER TABLE project_board_charters ADD COLUMN project_summary_json TEXT",
    ]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(project_board_sources)",
      "ALTER TABLE project_board_sources ADD COLUMN include_in_synthesis INTEGER NOT NULL DEFAULT 1",
    ]);
  });

  it("applies project-board question and synthesis migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "projectBoardQuestionSynthesis");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(
      PROJECT_STORE_MIGRATION_COLUMN_GROUPS.projectBoardQuestionSynthesis.length,
    );
    expect(calls.slice(0, 2)).toEqual([
      "PRAGMA table_info(project_board_questions)",
      "ALTER TABLE project_board_questions ADD COLUMN suggested_answer TEXT",
    ]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(project_board_synthesis_runs)",
      "ALTER TABLE project_board_synthesis_runs ADD COLUMN planning_snapshots_json TEXT NOT NULL DEFAULT '[]'",
    ]);
  });

  it("applies project-board execution artifact migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "projectBoardExecutionArtifacts");

    expect(calls).toEqual([
      "PRAGMA table_info(project_board_execution_artifacts)",
      "ALTER TABLE project_board_execution_artifacts ADD COLUMN source TEXT NOT NULL DEFAULT 'git'",
    ]);
  });

  it("applies automation and orchestration migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "automationOrchestration");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(
      PROJECT_STORE_MIGRATION_COLUMN_GROUPS.automationOrchestration.length,
    );
    expect(calls.slice(0, 2)).toEqual([
      "PRAGMA table_info(automation_schedules)",
      "ALTER TABLE automation_schedules ADD COLUMN last_run_at TEXT",
    ]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(orchestration_tasks)",
      "ALTER TABLE orchestration_tasks ADD COLUMN project_path TEXT",
    ]);
  });

  it("applies workflow run migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "workflowRuns");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(PROJECT_STORE_MIGRATION_COLUMN_GROUPS.workflowRuns.length);
    expect(calls.slice(0, 2)).toEqual([
      "PRAGMA table_info(workflow_artifacts)",
      "ALTER TABLE workflow_artifacts ADD COLUMN workflow_thread_id TEXT",
    ]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(workflow_runs)",
      "ALTER TABLE workflow_runs ADD COLUMN recovery_context_json TEXT",
    ]);
  });

  it("applies workflow exploration trace migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "workflowExplorationTraces");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(
      PROJECT_STORE_MIGRATION_COLUMN_GROUPS.workflowExplorationTraces.length,
    );
    expect(calls.slice(0, 2)).toEqual([
      "PRAGMA table_info(workflow_exploration_traces)",
      "ALTER TABLE workflow_exploration_traces ADD COLUMN events_json TEXT NOT NULL DEFAULT '[]'",
    ]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(workflow_exploration_traces)",
      "ALTER TABLE workflow_exploration_traces ADD COLUMN completed_at TEXT",
    ]);
  });

  it("applies workflow model-call migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "workflowModelCalls");

    expect(calls).toEqual([
      "PRAGMA table_info(workflow_model_calls)",
      "ALTER TABLE workflow_model_calls ADD COLUMN graph_node_id TEXT",
      "PRAGMA table_info(workflow_model_calls)",
      "ALTER TABLE workflow_model_calls ADD COLUMN graph_edge_id TEXT",
      "PRAGMA table_info(workflow_model_calls)",
      "ALTER TABLE workflow_model_calls ADD COLUMN item_key TEXT",
      "PRAGMA table_info(workflow_model_calls)",
      "ALTER TABLE workflow_model_calls ADD COLUMN cache_checkpoint_json TEXT",
    ]);
  });

  it("applies workflow discovery question migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "workflowDiscoveryQuestions");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(
      PROJECT_STORE_MIGRATION_COLUMN_GROUPS.workflowDiscoveryQuestions.length,
    );
    expect(calls.slice(0, 2)).toEqual([
      "PRAGMA table_info(workflow_discovery_questions)",
      "ALTER TABLE workflow_discovery_questions ADD COLUMN provider TEXT",
    ]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(workflow_discovery_questions)",
      "ALTER TABLE workflow_discovery_questions ADD COLUMN activity_events_json TEXT",
    ]);
  });

  it("applies planner and thread-goal migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "plannerThreadGoals");

    expect(calls.filter((call) => call.startsWith("ALTER TABLE"))).toHaveLength(
      PROJECT_STORE_MIGRATION_COLUMN_GROUPS.plannerThreadGoals.length,
    );
    expect(calls.slice(0, 2)).toEqual([
      "PRAGMA table_info(planner_plan_artifacts)",
      "ALTER TABLE planner_plan_artifacts ADD COLUMN diagrams_json TEXT NOT NULL DEFAULT '[]'",
    ]);
    expect(calls.slice(-2)).toEqual([
      "PRAGMA table_info(thread_goals)",
      "ALTER TABLE thread_goals ADD COLUMN provider_infra_failures INTEGER NOT NULL DEFAULT 0",
    ]);
  });

  it("applies final workflow discovery migration columns through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreColumnGroup(fakeSchemaDb([], calls), "workflowDiscoveryFinal");

    expect(calls).toEqual([
      "PRAGMA table_info(workflow_discovery_questions)",
      "ALTER TABLE workflow_discovery_questions ADD COLUMN cache_checkpoint_json TEXT",
      "PRAGMA table_info(workflow_discovery_questions)",
      "ALTER TABLE workflow_discovery_questions ADD COLUMN graph_patch_json TEXT",
    ]);
  });

  it("keeps post-bootstrap migration index SQL in the schema module", () => {
    expect(PROJECT_STORE_MIGRATION_INDEX_SQL).toEqual({
      threadsParentThread: "CREATE INDEX IF NOT EXISTS idx_threads_parent_thread ON threads(parent_thread_id, child_order)",
      projectBoardSourcesBoardSourceKey:
        "CREATE INDEX IF NOT EXISTS idx_project_board_sources_board_source_key ON project_board_sources(board_id, source_key)",
      projectBoardExecutionArtifactsBoardCard:
        "CREATE INDEX IF NOT EXISTS idx_project_board_execution_artifacts_board_card ON project_board_execution_artifacts(board_id, card_id, updated_at)",
      workflowDiscoveryQuestionsRevision:
        "CREATE INDEX IF NOT EXISTS idx_workflow_discovery_questions_revision ON workflow_discovery_questions(revision_id, question_order)",
      threadWakeContinuationsOperation:
        "CREATE INDEX IF NOT EXISTS idx_thread_wake_continuations_operation ON thread_wake_continuations(thread_id, operation_key, status, due_at)",
    });
  });

  it("applies named migration indexes through the schema module boundary", () => {
    const calls: string[] = [];
    ensureProjectStoreIndex(fakeSchemaDb([], calls), "workflowDiscoveryQuestionsRevision");

    expect(calls).toEqual([
      "CREATE INDEX IF NOT EXISTS idx_workflow_discovery_questions_revision ON workflow_discovery_questions(revision_id, question_order)",
      "run",
    ]);
  });

  it("keeps ordered schema migration steps in the schema module", () => {
    expect(PROJECT_STORE_SCHEMA_MIGRATION_STEPS_BEFORE_ORCHESTRATION_BACKFILL).toEqual([
      { kind: "columnGroup", key: "coreThreadSubagent" },
      { kind: "index", key: "threadsParentThread" },
      { kind: "columnGroup", key: "runtimeSupport" },
      { kind: "columnGroup", key: "projectBoardCards" },
      { kind: "columnGroup", key: "projectBoardSourceMetadata" },
      { kind: "index", key: "projectBoardSourcesBoardSourceKey" },
      { kind: "columnGroup", key: "projectBoardQuestionSynthesis" },
      { kind: "columnGroup", key: "projectBoardExecutionArtifacts" },
      { kind: "columnGroup", key: "projectBoardThreadScope" },
      { kind: "index", key: "projectBoardExecutionArtifactsBoardCard" },
      { kind: "columnGroup", key: "automationOrchestration" },
    ]);
    expect(PROJECT_STORE_SCHEMA_MIGRATION_STEPS_AFTER_ORCHESTRATION_BACKFILL_BEFORE_PLANNER_REPAIR).toEqual([
      { kind: "columnGroup", key: "workflowRuns" },
      { kind: "columnGroup", key: "workflowExplorationTraces" },
      { kind: "columnGroup", key: "workflowModelCalls" },
      { kind: "columnGroup", key: "workflowDiscoveryQuestions" },
      { kind: "columnGroup", key: "plannerThreadGoals" },
      { kind: "threadGoalProviderStatusCheck" },
    ]);
    expect(PROJECT_STORE_SCHEMA_MIGRATION_STEPS_AFTER_PLANNER_REPAIR).toEqual([
      { kind: "columnGroup", key: "workflowDiscoveryFinal" },
      { kind: "columnGroup", key: "callableWorkflowPatternGraphs" },
      { kind: "columnGroup", key: "threadWakeContinuations" },
      { kind: "threadWakeContinuationStatusCheck" },
      { kind: "index", key: "threadWakeContinuationsOperation" },
      { kind: "index", key: "workflowDiscoveryQuestionsRevision" },
    ]);
  });

  it("applies ordered schema migration steps through the schema module boundary", () => {
    const calls: string[] = [];
    applyProjectStoreSchemaMigrationSteps(fakeSchemaDb([], calls), [
      { kind: "columnGroup", key: "workflowDiscoveryFinal" },
      { kind: "index", key: "workflowDiscoveryQuestionsRevision" },
    ]);

    expect(calls).toEqual([
      "PRAGMA table_info(workflow_discovery_questions)",
      "ALTER TABLE workflow_discovery_questions ADD COLUMN cache_checkpoint_json TEXT",
      "PRAGMA table_info(workflow_discovery_questions)",
      "ALTER TABLE workflow_discovery_questions ADD COLUMN graph_patch_json TEXT",
      "CREATE INDEX IF NOT EXISTS idx_workflow_discovery_questions_revision ON workflow_discovery_questions(revision_id, question_order)",
      "run",
    ]);
  });

  it("keeps data migration SQL in the schema module", () => {
    expect(PROJECT_STORE_DATA_MIGRATION_SQL).toEqual({
      orchestrationTasksProjectPath:
        "UPDATE orchestration_tasks SET project_path = ? WHERE project_path IS NULL OR trim(project_path) = ''",
      threadsLastReadAt: "UPDATE threads SET last_read_at = updated_at WHERE last_read_at IS NULL",
      legacySettingModel: "UPDATE settings SET value_json = ? WHERE key = 'model' AND value_json = ?",
      legacyThreadModel: "UPDATE threads SET model = ? WHERE model = ?",
      permissionModeSettingDefault: "UPDATE settings SET value_json = ? WHERE key = ? AND value_json = ?",
      permissionModeStarterThreads: `UPDATE threads
         SET permission_mode = 'workspace'
         WHERE permission_mode = 'full-access'
           AND title = 'New chat'
           AND last_message_preview = ''
           AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)
           AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.thread_id = threads.id)
           AND NOT EXISTS (SELECT 1 FROM orchestration_runs WHERE orchestration_runs.thread_id = threads.id)`,
      plannerPlanWorkflowStates: `UPDATE planner_plan_artifacts
         SET workflow_state = CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM planner_decision_questions q WHERE q.artifact_id = planner_plan_artifacts.id
           ) THEN 'draft'
           WHEN EXISTS (
             SELECT 1
             FROM planner_decision_questions q
             WHERE q.artifact_id = planner_plan_artifacts.id
               AND q.required = 1
               AND q.answer_kind IS NULL
           ) THEN 'questions_pending'
           ELSE 'answers_complete'
         END
         WHERE workflow_state IS NULL
            OR workflow_state NOT IN ('draft', 'questions_pending', 'answers_complete', 'finalizing', 'durable_generating', 'validating', 'repairing', 'durable_ready', 'durable_ready_with_fallbacks', 'failed')
            OR (
              workflow_state = 'draft'
              AND EXISTS (
                SELECT 1 FROM planner_decision_questions q WHERE q.artifact_id = planner_plan_artifacts.id
              )
            )`,
    });
  });

  it("applies data migrations through the schema module boundary", () => {
    const calls: string[] = [];
    const runs: unknown[][] = [];
    const db = fakeSchemaDb([], calls, runs);

    backfillProjectStoreOrchestrationTaskProjectPath(db, "/workspace/project");
    backfillProjectStoreThreadLastReadAt(db);
    replaceProjectStoreLegacyModelId(db, "legacy-model", "replacement-model");

    expect(calls).toEqual([
      "UPDATE orchestration_tasks SET project_path = ? WHERE project_path IS NULL OR trim(project_path) = ''",
      "run",
      "UPDATE threads SET last_read_at = updated_at WHERE last_read_at IS NULL",
      "run",
      "UPDATE settings SET value_json = ? WHERE key = 'model' AND value_json = ?",
      "run",
      "UPDATE threads SET model = ? WHERE model = ?",
      "run",
    ]);
    expect(runs).toEqual([
      ["/workspace/project"],
      [],
      [JSON.stringify("replacement-model"), JSON.stringify("legacy-model")],
      ["replacement-model", "legacy-model"],
    ]);
  });

  it("repairs planner plan workflow states through the schema module boundary", () => {
    const calls: string[] = [];
    repairProjectStorePlannerPlanWorkflowStates(fakeSchemaDb([], calls));

    expect(calls).toEqual([PROJECT_STORE_DATA_MIGRATION_SQL.plannerPlanWorkflowStates, "run"]);
  });

  it("migrates permission mode defaults through the schema module boundary", () => {
    const calls: string[] = [];
    const runs: unknown[][] = [];
    migrateProjectStorePermissionModeDefaultsToWorkspace(fakeSchemaDb([], calls, runs));

    expect(calls).toEqual([
      PROJECT_STORE_DATA_MIGRATION_SQL.permissionModeSettingDefault,
      "run",
      PROJECT_STORE_DATA_MIGRATION_SQL.permissionModeStarterThreads,
      "run",
    ]);
    expect(runs).toEqual([[JSON.stringify("workspace"), "permissionMode", JSON.stringify("full-access")], []]);
  });
});

function schemaNames(pattern: RegExp): string[] {
  return Array.from(PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL.matchAll(pattern), (match) => match[1]);
}

function fakeSchemaDb(columnNames: string[], calls: string[], runs: unknown[][] = []): never {
  return {
    prepare: (sql: string) => {
      calls.push(sql);
      return {
        all: () => columnNames.map((name) => ({ name })),
        run: (...args: unknown[]) => {
          calls.push("run");
          runs.push(args);
        },
      };
    },
    exec: (sql: string) => {
      calls.push(sql);
    },
  } as never;
}
