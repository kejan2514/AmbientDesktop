import type Database from "better-sqlite3";
import { AMBIENT_DEFAULT_MODEL } from "../../shared/ambientModels";

export const PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL = `
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        parent_thread_id TEXT,
        parent_message_id TEXT,
        parent_run_id TEXT,
        subagent_run_id TEXT,
        canonical_task_path TEXT,
        child_order INTEGER,
        collapsed_by_default INTEGER NOT NULL DEFAULT 0,
        child_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
          last_read_at TEXT,
          last_message_preview TEXT NOT NULL DEFAULT '',
          permission_mode TEXT NOT NULL DEFAULT 'workspace',
          collaboration_mode TEXT NOT NULL DEFAULT 'agent',
          model TEXT NOT NULL DEFAULT '${AMBIENT_DEFAULT_MODEL}',
          thinking_level TEXT NOT NULL DEFAULT 'xhigh',
          memory_enabled INTEGER NOT NULL DEFAULT 0,
          pi_session_file TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          workflow_recording_json TEXT
        );
      CREATE TABLE IF NOT EXISTS thread_worktrees (
        thread_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_ref TEXT,
        upstream TEXT,
        worktree_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checkpoint_id TEXT,
        error TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        protocol_version TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        parent_message_id TEXT,
        child_thread_id TEXT NOT NULL UNIQUE,
        canonical_task_path TEXT NOT NULL,
        role_id TEXT NOT NULL,
        role_profile_snapshot_json TEXT,
        effective_role_snapshot_json TEXT,
        dependency_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        feature_flag_snapshot_json TEXT NOT NULL,
        model_runtime_snapshot_json TEXT NOT NULL,
        capacity_lease_snapshot_json TEXT,
        symphony_launch_contract_json TEXT,
        symphony_mutation_lease_json TEXT,
        result_artifact_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        closed_at TEXT,
        FOREIGN KEY(parent_thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY(child_thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subagent_spawn_edges (
        parent_run_id TEXT NOT NULL,
        child_run_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL,
        canonical_task_path TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        capacity_released_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(parent_run_id, child_run_id),
        FOREIGN KEY(child_run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subagent_run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        preview_json TEXT,
        artifact_path TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence),
        FOREIGN KEY(run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subagent_mailbox_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        delivery_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        FOREIGN KEY(run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subagent_parent_mailbox_events (
        id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        parent_message_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        delivery_state TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS subagent_prompt_snapshots (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        prompt_preview TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence),
        FOREIGN KEY(run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subagent_tool_scope_snapshots (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        resolver_inputs_json TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence),
        FOREIGN KEY(run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subagent_wait_barriers (
        id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        child_run_ids_json TEXT NOT NULL,
        dependency_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_policy TEXT NOT NULL,
        owner_kind TEXT,
        owner_id TEXT,
        quorum_threshold INTEGER,
        timeout_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_artifact_json TEXT
      );
      CREATE TABLE IF NOT EXISTS subagent_maturity_evidence (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        evidence_key TEXT,
        status TEXT NOT NULL,
        run_id TEXT,
        parent_run_id TEXT,
        artifact_path TEXT,
        reviewer TEXT,
        notes TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subagent_batch_jobs (
        id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        canonical_task_path TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        ledger_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(parent_thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS subagent_batch_result_reports (
        job_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        child_run_id TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id, report_id),
        FOREIGN KEY(job_id) REFERENCES subagent_batch_jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS message_voice_states (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        provider_capability_id TEXT,
        provider_id TEXT,
        voice_id TEXT,
        spoken_text TEXT,
        spoken_text_chars INTEGER NOT NULL,
        source_text_chars INTEGER NOT NULL,
        audio_path TEXT,
        last_audio_path TEXT,
        media_url TEXT,
        mime_type TEXT,
        duration_ms INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY(source_message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT,
        diagnostics_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY(assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS run_diagnostic_payloads (
        run_id TEXT PRIMARY KEY,
        diagnostics_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS context_usage_snapshots (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        model_id TEXT,
        source TEXT NOT NULL,
        tokens INTEGER,
        context_window INTEGER,
        percent REAL,
        latest_compaction_at TEXT,
        compaction_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        diagnostics_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS thread_goals (
        thread_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'provider_unavailable', 'complete'
        )),
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        continuation_turns INTEGER NOT NULL DEFAULT 0,
        no_progress_turns INTEGER NOT NULL DEFAULT 0,
        provider_infra_failures INTEGER NOT NULL DEFAULT 0,
        status_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        last_continued_at TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS thread_wake_continuations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'cancelled', 'failed', 'resolved', 'superseded')),
        reason TEXT NOT NULL,
        job_id TEXT,
        operation_key TEXT,
        supersedes_wake_ids_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        resolved_at TEXT,
        resolution_reason TEXT,
        error TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS permission_audit (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        risk TEXT NOT NULL,
        decision TEXT NOT NULL,
        detail TEXT,
        reason TEXT NOT NULL,
        decision_source TEXT,
        grant_id TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS permission_grants (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        created_by TEXT NOT NULL,
        permission_mode_at_creation TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        thread_id TEXT,
        workflow_thread_id TEXT,
        project_path TEXT,
        workspace_path TEXT,
        action_kind TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        target_label TEXT NOT NULL,
        conditions_json TEXT,
        source TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS planner_plan_artifacts (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          status TEXT NOT NULL,
          workflow_state TEXT NOT NULL DEFAULT 'draft',
          finalization_attempt_json TEXT,
          durable_artifact_path TEXT,
          durable_artifact_generated_at TEXT,
          durable_artifact_validation_json TEXT,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          steps_json TEXT NOT NULL DEFAULT '[]',
          open_questions_json TEXT NOT NULL DEFAULT '[]',
          risks_json TEXT NOT NULL DEFAULT '[]',
          verification_json TEXT NOT NULL DEFAULT '[]',
          diagrams_json TEXT NOT NULL DEFAULT '[]',
          warnings_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES messages(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS planner_decision_questions (
          id TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          question_order INTEGER NOT NULL,
          question TEXT NOT NULL,
          recommended_option_id TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 0,
          options_json TEXT NOT NULL DEFAULT '[]',
          answer_kind TEXT,
          answer_option_id TEXT,
          answer_custom_text TEXT,
          answered_at TEXT,
          created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(artifact_id, id),
        FOREIGN KEY(artifact_id) REFERENCES planner_plan_artifacts(id) ON DELETE CASCADE
      );
        CREATE TABLE IF NOT EXISTS project_boards (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          source_thread_id TEXT,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          charter_id TEXT,
          active_draft_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_board_charters (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          goal TEXT NOT NULL DEFAULT '',
          current_state TEXT NOT NULL DEFAULT '',
          target_user TEXT NOT NULL DEFAULT '',
          non_goals_json TEXT NOT NULL DEFAULT '[]',
          quality_bar TEXT NOT NULL DEFAULT '',
          test_policy_json TEXT NOT NULL DEFAULT '{}',
          decision_policy_json TEXT NOT NULL DEFAULT '{}',
          dependency_policy_json TEXT NOT NULL DEFAULT '{}',
          budget_policy_json TEXT NOT NULL DEFAULT '{}',
          source_policy_json TEXT NOT NULL DEFAULT '{}',
          markdown TEXT NOT NULL DEFAULT '',
          project_summary_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(board_id) REFERENCES project_boards(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_board_cards (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          candidate_status TEXT NOT NULL DEFAULT 'ready_to_create',
          priority INTEGER,
          phase TEXT,
          labels_json TEXT NOT NULL DEFAULT '[]',
          blocked_by_json TEXT NOT NULL DEFAULT '[]',
          acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
          test_plan_json TEXT NOT NULL DEFAULT '{"unit":[],"integration":[],"visual":[],"manual":[]}',
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          clarification_questions_json TEXT NOT NULL DEFAULT '[]',
          clarification_suggestions_json TEXT NOT NULL DEFAULT '[]',
          clarification_answers_json TEXT NOT NULL DEFAULT '[]',
          clarification_decisions_json TEXT NOT NULL DEFAULT '[]',
          run_feedback_json TEXT NOT NULL DEFAULT '[]',
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_thread_id TEXT,
          source_message_id TEXT,
          orchestration_task_id TEXT,
          execution_thread_id TEXT,
          execution_session_policy TEXT NOT NULL DEFAULT 'reuse_card_session',
          proof_review_json TEXT,
          split_outcome_json TEXT,
          objective_provenance_json TEXT,
          ui_mock_role TEXT,
          requires_ui_mock_approval INTEGER NOT NULL DEFAULT 0,
          user_touched_fields_json TEXT NOT NULL DEFAULT '[]',
          user_touched_at TEXT,
          pending_pi_update_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(board_id) REFERENCES project_boards(id) ON DELETE CASCADE,
          UNIQUE(board_id, source_kind, source_id)
        );
        CREATE TABLE IF NOT EXISTS project_board_sources (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_key TEXT,
          content_hash TEXT,
          change_state TEXT,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          excerpt TEXT,
          path TEXT,
          thread_id TEXT,
          artifact_id TEXT,
          message_id TEXT,
          byte_size INTEGER,
          mtime TEXT,
          classification_reason TEXT,
          classified_by TEXT,
          classification_confidence REAL,
          authority_role TEXT,
          include_in_synthesis INTEGER NOT NULL DEFAULT 1,
          relevance INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(board_id) REFERENCES project_boards(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_board_questions (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          question_order INTEGER NOT NULL,
          question TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 1,
          answer TEXT,
          answered_at TEXT,
          suggested_answer TEXT,
          suggestion_rationale TEXT,
          suggestion_confidence TEXT,
          suggestion_source_ids_json TEXT NOT NULL DEFAULT '[]',
          suggestion_context_fingerprint TEXT,
          suggestion_generated_at TEXT,
          suggestion_model TEXT,
          suggestion_provider_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(board_id) REFERENCES project_boards(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_board_events (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          event_kind TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          entity_kind TEXT,
          entity_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY(board_id) REFERENCES project_boards(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_board_synthesis_proposals (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          goal TEXT NOT NULL DEFAULT '',
          current_state TEXT NOT NULL DEFAULT '',
          target_user TEXT NOT NULL DEFAULT '',
          quality_bar TEXT NOT NULL DEFAULT '',
          assumptions_json TEXT NOT NULL DEFAULT '[]',
          questions_json TEXT NOT NULL DEFAULT '[]',
          answers_json TEXT NOT NULL DEFAULT '[]',
          source_notes_json TEXT NOT NULL DEFAULT '[]',
          cards_json TEXT NOT NULL DEFAULT '[]',
          review_report_json TEXT,
          model TEXT,
          duration_ms INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          applied_at TEXT,
          FOREIGN KEY(board_id) REFERENCES project_boards(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS project_board_synthesis_runs (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          proposal_id TEXT,
          retry_of_run_id TEXT,
          status TEXT NOT NULL,
          stage TEXT NOT NULL,
          model TEXT,
          source_count INTEGER NOT NULL DEFAULT 0,
          included_source_count INTEGER NOT NULL DEFAULT 0,
          source_char_count INTEGER NOT NULL DEFAULT 0,
          prompt_char_count INTEGER,
          response_char_count INTEGER,
          card_count INTEGER,
          question_count INTEGER,
          warning_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          events_json TEXT NOT NULL DEFAULT '[]',
          progressive_records_json TEXT NOT NULL DEFAULT '[]',
          planning_snapshots_json TEXT NOT NULL DEFAULT '[]',
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(board_id) REFERENCES project_boards(id) ON DELETE CASCADE,
          FOREIGN KEY(proposal_id) REFERENCES project_board_synthesis_proposals(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS project_board_execution_artifacts (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          card_id TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'git',
          agent_id TEXT,
          pi_session_id TEXT,
          workspace_branch TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          proof_json TEXT,
          handoff_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(board_id) REFERENCES project_boards(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS plugin_settings (
        plugin_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_trust (
        plugin_id TEXT PRIMARY KEY,
        fingerprint TEXT,
        trusted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder_kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_thread_folders (
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source_kind, source_id),
        FOREIGN KEY(folder_id) REFERENCES automation_folders(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS automation_schedules (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_version INTEGER,
        created_target_version_id TEXT,
        dedicated_thread_id TEXT,
        preset TEXT NOT NULL,
        cron_expression TEXT,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        skip_if_active INTEGER NOT NULL,
        concurrency_policy TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        run_limits_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_schedule_exceptions (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        occurrence_at TEXT NOT NULL,
        exception_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        replacement_run_at TEXT,
        run_limits_json TEXT,
        reason TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(schedule_id) REFERENCES automation_schedules(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS orchestration_tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        state TEXT NOT NULL,
        priority INTEGER,
        labels_json TEXT NOT NULL DEFAULT '[]',
        blocked_by_json TEXT NOT NULL DEFAULT '[]',
        project_path TEXT,
        branch_name TEXT,
        workspace_path TEXT,
        source_kind TEXT NOT NULL DEFAULT 'local',
        source_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orchestration_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        thread_id TEXT,
        pi_session_file TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        last_event_at TEXT,
        error TEXT,
        proof_of_work_json TEXT,
        FOREIGN KEY(task_id) REFERENCES orchestration_tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workflow_agent_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder_kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_agent_threads (
        id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        chat_thread_id TEXT,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        phase TEXT NOT NULL,
        initial_request TEXT NOT NULL,
        active_artifact_id TEXT,
        active_graph_snapshot_id TEXT,
        trace_mode TEXT NOT NULL DEFAULT 'production',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(folder_id) REFERENCES workflow_agent_folders(id) ON DELETE SET DEFAULT
      );
      CREATE TABLE IF NOT EXISTS workflow_graph_snapshots (
        id TEXT PRIMARY KEY,
        workflow_thread_id TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        snapshot_source TEXT NOT NULL,
        summary TEXT NOT NULL,
        graph_json TEXT NOT NULL,
        artifact_path TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(workflow_thread_id) REFERENCES workflow_agent_threads(id) ON DELETE CASCADE,
        UNIQUE(workflow_thread_id, snapshot_version)
      );
      CREATE TABLE IF NOT EXISTS workflow_exploration_traces (
        id TEXT PRIMARY KEY,
        workflow_thread_id TEXT NOT NULL,
        exploration_id TEXT NOT NULL,
        exploration_node_id TEXT NOT NULL,
        request_text TEXT NOT NULL,
        model TEXT,
        capability_manifest_json TEXT NOT NULL,
        observations_json TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        distillation_json TEXT NOT NULL,
        run_status TEXT NOT NULL DEFAULT 'succeeded',
        graph_snapshot_id TEXT,
        latest_progress_json TEXT,
        provider_health_json TEXT,
        retry_metadata_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(workflow_thread_id) REFERENCES workflow_agent_threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workflow_versions (
        id TEXT PRIMARY KEY,
        workflow_thread_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        graph_snapshot_id TEXT,
        source_path TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        git_commit_hash TEXT,
        version_status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(workflow_thread_id) REFERENCES workflow_agent_threads(id) ON DELETE CASCADE,
        FOREIGN KEY(artifact_id) REFERENCES workflow_artifacts(id) ON DELETE CASCADE,
        FOREIGN KEY(graph_snapshot_id) REFERENCES workflow_graph_snapshots(id) ON DELETE SET NULL,
        UNIQUE(workflow_thread_id, version_number)
      );
      CREATE TABLE IF NOT EXISTS workflow_revisions (
        id TEXT PRIMARY KEY,
        workflow_thread_id TEXT NOT NULL,
        base_version_id TEXT,
        base_artifact_id TEXT,
        requested_change TEXT NOT NULL,
        proposed_graph_snapshot_id TEXT,
        graph_diff_json TEXT,
        source_diff TEXT,
        revision_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workflow_thread_id) REFERENCES workflow_agent_threads(id) ON DELETE CASCADE,
        FOREIGN KEY(base_version_id) REFERENCES workflow_versions(id) ON DELETE SET NULL,
        FOREIGN KEY(base_artifact_id) REFERENCES workflow_artifacts(id) ON DELETE SET NULL,
        FOREIGN KEY(proposed_graph_snapshot_id) REFERENCES workflow_graph_snapshots(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_discovery_questions (
        id TEXT PRIMARY KEY,
        workflow_thread_id TEXT NOT NULL,
        revision_id TEXT,
        question_order INTEGER NOT NULL,
        category TEXT NOT NULL,
        context TEXT NOT NULL,
        question TEXT NOT NULL,
        choices_json TEXT NOT NULL,
        allow_freeform INTEGER NOT NULL,
        answer_json TEXT,
        graph_impact TEXT,
        provider TEXT,
        provider_model TEXT,
        policy_context_summary TEXT,
        capability_search_json TEXT,
        capability_descriptions_json TEXT,
        blocked_reasons_json TEXT,
        access_requests_json TEXT,
        activity_events_json TEXT,
        cache_checkpoint_json TEXT,
        graph_patch_json TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        FOREIGN KEY(workflow_thread_id) REFERENCES workflow_agent_threads(id) ON DELETE CASCADE,
        FOREIGN KEY(revision_id) REFERENCES workflow_revisions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workflow_artifacts (
        id TEXT PRIMARY KEY,
        workflow_thread_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        source_path TEXT NOT NULL,
        state_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        report_path TEXT,
        graph_snapshot_id TEXT,
        provider_health_json TEXT,
        retry_metadata_json TEXT,
        recovery_context_json TEXT,
        FOREIGN KEY(artifact_id) REFERENCES workflow_artifacts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS callable_workflow_tasks (
        id TEXT PRIMARY KEY,
        launch_id TEXT NOT NULL UNIQUE,
        parent_thread_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        parent_message_id TEXT,
        tool_call_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        status_label TEXT NOT NULL,
        blocking INTEGER NOT NULL,
        default_collapsed INTEGER NOT NULL,
        progress_visible INTEGER NOT NULL,
        token_cost_tracking INTEGER NOT NULL,
        pause_resume_cancel INTEGER NOT NULL,
        cancel_handle TEXT NOT NULL,
        runner_target TEXT NOT NULL,
        runner_deferred_reason TEXT NOT NULL,
        workflow_artifact_id TEXT,
        workflow_run_id TEXT,
        error_message TEXT,
        pattern_graph_snapshot_json TEXT,
        execution_plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(parent_thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workflow_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        message TEXT,
        graph_node_id TEXT,
        graph_edge_id TEXT,
        item_key TEXT,
        data_json TEXT,
        FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(artifact_id) REFERENCES workflow_artifacts(id) ON DELETE CASCADE,
        UNIQUE(run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS workflow_model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        artifact_id TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        cache_key TEXT,
        cache_checkpoint_json TEXT,
        model TEXT,
        graph_node_id TEXT,
        graph_edge_id TEXT,
        item_key TEXT,
        validation_error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL,
        FOREIGN KEY(artifact_id) REFERENCES workflow_artifacts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS artifact_drafts (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        assembly TEXT NOT NULL,
        state TEXT NOT NULL,
        origin TEXT NOT NULL,
        source_run_id TEXT,
        root_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        content_path TEXT,
        validation_json TEXT NOT NULL DEFAULT '{}',
        retention_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS artifact_draft_events (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(draft_id) REFERENCES artifact_drafts(id) ON DELETE CASCADE,
        UNIQUE(draft_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_message_voice_states_thread ON message_voice_states(thread_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at);
      CREATE INDEX IF NOT EXISTS idx_thread_worktrees_path ON thread_worktrees(worktree_path);
      CREATE INDEX IF NOT EXISTS idx_runs_thread_status ON runs(thread_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_context_usage_thread_updated ON context_usage_snapshots(thread_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_permission_audit_thread_created ON permission_audit(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_permission_audit_run ON permission_audit(run_id);
      CREATE INDEX IF NOT EXISTS idx_permission_grants_scope_target ON permission_grants(scope_kind, target_hash, revoked_at);
      CREATE INDEX IF NOT EXISTS idx_permission_grants_thread ON permission_grants(thread_id, revoked_at);
      CREATE INDEX IF NOT EXISTS idx_permission_grants_workspace ON permission_grants(workspace_path, revoked_at);
      CREATE INDEX IF NOT EXISTS idx_planner_plan_artifacts_thread ON planner_plan_artifacts(thread_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_planner_decision_questions_artifact ON planner_decision_questions(artifact_id, question_order);
        CREATE INDEX IF NOT EXISTS idx_project_boards_project_updated ON project_boards(project_path, updated_at);
        CREATE INDEX IF NOT EXISTS idx_project_board_charters_board_version ON project_board_charters(board_id, version);
        CREATE INDEX IF NOT EXISTS idx_project_board_cards_board_status ON project_board_cards(board_id, status, priority, updated_at);
        CREATE INDEX IF NOT EXISTS idx_project_board_cards_source ON project_board_cards(source_kind, source_id);
        CREATE INDEX IF NOT EXISTS idx_project_board_sources_board_kind ON project_board_sources(board_id, source_kind, relevance);
        CREATE INDEX IF NOT EXISTS idx_project_board_questions_board_order ON project_board_questions(board_id, question_order);
        CREATE INDEX IF NOT EXISTS idx_project_board_events_board_created ON project_board_events(board_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_project_board_synthesis_proposals_board_status
          ON project_board_synthesis_proposals(board_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_project_board_synthesis_runs_board_status
          ON project_board_synthesis_runs(board_id, status, started_at);
        CREATE INDEX IF NOT EXISTS idx_project_board_execution_artifacts_board_card
          ON project_board_execution_artifacts(board_id, card_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_automation_folders_kind_updated ON automation_folders(folder_kind, updated_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_agent_folders_kind_updated ON workflow_agent_folders(folder_kind, updated_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_agent_threads_folder_updated ON workflow_agent_threads(folder_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_agent_threads_artifact ON workflow_agent_threads(active_artifact_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_graph_snapshots_thread_version ON workflow_graph_snapshots(workflow_thread_id, snapshot_version);
      CREATE INDEX IF NOT EXISTS idx_workflow_exploration_traces_thread_created ON workflow_exploration_traces(workflow_thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_versions_thread_version ON workflow_versions(workflow_thread_id, version_number);
      CREATE INDEX IF NOT EXISTS idx_workflow_versions_artifact ON workflow_versions(artifact_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_revisions_thread_updated ON workflow_revisions(workflow_thread_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_revisions_base_version ON workflow_revisions(base_version_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_discovery_questions_thread ON workflow_discovery_questions(workflow_thread_id, question_order);
      CREATE INDEX IF NOT EXISTS idx_automation_thread_folders_folder ON automation_thread_folders(folder_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_automation_schedules_target ON automation_schedules(target_kind, target_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_automation_schedules_next_run ON automation_schedules(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automation_schedule_exceptions_schedule ON automation_schedule_exceptions(schedule_id, occurrence_at, status);
      CREATE INDEX IF NOT EXISTS idx_orchestration_tasks_state_priority ON orchestration_tasks(state, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_orchestration_runs_task_status ON orchestration_runs(task_id, status, started_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_updated ON workflow_artifacts(updated_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_artifact_status ON workflow_runs(artifact_id, status, started_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_run_events_run_seq ON workflow_run_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_callable_workflow_tasks_parent_run ON callable_workflow_tasks(parent_run_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_callable_workflow_tasks_parent_thread ON callable_workflow_tasks(parent_thread_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_model_calls_run ON workflow_model_calls(run_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_model_calls_artifact ON workflow_model_calls(artifact_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_artifact_drafts_state_updated ON artifact_drafts(state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_artifact_drafts_source_run ON artifact_drafts(source_run_id);
      CREATE INDEX IF NOT EXISTS idx_artifact_drafts_expires ON artifact_drafts(expires_at);
      CREATE INDEX IF NOT EXISTS idx_artifact_draft_events_draft_seq ON artifact_draft_events(draft_id, seq);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_child ON subagent_runs(child_thread_id);
      CREATE INDEX IF NOT EXISTS idx_subagent_run_events_run_seq ON subagent_run_events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_subagent_mailbox_events_run ON subagent_mailbox_events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_subagent_parent_mailbox_events_parent_run ON subagent_parent_mailbox_events(parent_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_subagent_parent_mailbox_events_parent_thread ON subagent_parent_mailbox_events(parent_thread_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_parent_mailbox_events_idempotency ON subagent_parent_mailbox_events(parent_run_id, type, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_subagent_prompt_snapshots_run ON subagent_prompt_snapshots(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_subagent_tool_scope_snapshots_run ON subagent_tool_scope_snapshots(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_subagent_wait_barriers_parent_run ON subagent_wait_barriers(parent_run_id, status);
      CREATE INDEX IF NOT EXISTS idx_subagent_wait_barriers_parent_thread ON subagent_wait_barriers(parent_thread_id, status);
      CREATE INDEX IF NOT EXISTS idx_subagent_maturity_evidence_kind ON subagent_maturity_evidence(kind, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_maturity_evidence_key ON subagent_maturity_evidence(kind, evidence_key) WHERE evidence_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_subagent_batch_jobs_parent_run ON subagent_batch_jobs(parent_run_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_batch_result_reports_job_item_once ON subagent_batch_result_reports(job_id, item_id);
      CREATE INDEX IF NOT EXISTS idx_thread_wake_continuations_pending_due ON thread_wake_continuations(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_thread_wake_continuations_thread ON thread_wake_continuations(thread_id, status, due_at);`;

export function applyProjectStoreBootstrapSchema(db: Database.Database): void {
  db.exec(PROJECT_STORE_SCHEMA_BOOTSTRAP_SQL);
}

export const PROJECT_STORE_MIGRATION_INDEX_SQL = {
  threadsParentThread: "CREATE INDEX IF NOT EXISTS idx_threads_parent_thread ON threads(parent_thread_id, child_order)",
  projectBoardSourcesBoardSourceKey:
    "CREATE INDEX IF NOT EXISTS idx_project_board_sources_board_source_key ON project_board_sources(board_id, source_key)",
  projectBoardExecutionArtifactsBoardCard:
    "CREATE INDEX IF NOT EXISTS idx_project_board_execution_artifacts_board_card ON project_board_execution_artifacts(board_id, card_id, updated_at)",
  workflowDiscoveryQuestionsRevision:
    "CREATE INDEX IF NOT EXISTS idx_workflow_discovery_questions_revision ON workflow_discovery_questions(revision_id, question_order)",
  threadWakeContinuationsOperation:
    "CREATE INDEX IF NOT EXISTS idx_thread_wake_continuations_operation ON thread_wake_continuations(thread_id, operation_key, status, due_at)",
} as const;

export type ProjectStoreMigrationIndexKey = keyof typeof PROJECT_STORE_MIGRATION_INDEX_SQL;

export function ensureProjectStoreIndex(db: Database.Database, key: ProjectStoreMigrationIndexKey): void {
  db.prepare(PROJECT_STORE_MIGRATION_INDEX_SQL[key]).run();
}

export const PROJECT_STORE_DATA_MIGRATION_SQL = {
  orchestrationTasksProjectPath: "UPDATE orchestration_tasks SET project_path = ? WHERE project_path IS NULL OR trim(project_path) = ''",
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
} as const;

export function backfillProjectStoreOrchestrationTaskProjectPath(db: Database.Database, projectPath: string): void {
  db.prepare(PROJECT_STORE_DATA_MIGRATION_SQL.orchestrationTasksProjectPath).run(projectPath);
}

export function backfillProjectStoreThreadLastReadAt(db: Database.Database): void {
  db.prepare(PROJECT_STORE_DATA_MIGRATION_SQL.threadsLastReadAt).run();
}

export function replaceProjectStoreLegacyModelId(db: Database.Database, legacyModelId: string, replacementModelId: string): void {
  db.prepare(PROJECT_STORE_DATA_MIGRATION_SQL.legacySettingModel).run(JSON.stringify(replacementModelId), JSON.stringify(legacyModelId));
  db.prepare(PROJECT_STORE_DATA_MIGRATION_SQL.legacyThreadModel).run(replacementModelId, legacyModelId);
}

export function repairProjectStorePlannerPlanWorkflowStates(db: Database.Database): void {
  db.prepare(PROJECT_STORE_DATA_MIGRATION_SQL.plannerPlanWorkflowStates).run();
}

export function migrateProjectStoreProjectBoardThreadScope(db: Database.Database): void {
  ensureProjectStoreColumn(db, "project_boards", "source_thread_id", "TEXT");
  db.transaction(() => {
    db.prepare(
      `UPDATE project_boards
       SET source_thread_id = (
         SELECT source.thread_id
         FROM project_board_sources source
         WHERE source.board_id = project_boards.id
           AND source.thread_id IS NOT NULL
           AND trim(source.thread_id) != ''
         ORDER BY
           CASE source.source_kind
             WHEN 'plan_artifact' THEN 0
             WHEN 'implementation_plan' THEN 1
             WHEN 'thread' THEN 2
             ELSE 3
           END,
           source.relevance DESC,
           source.rowid ASC
         LIMIT 1
       )
       WHERE source_thread_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM project_board_sources source
           WHERE source.board_id = project_boards.id
             AND source.thread_id IS NOT NULL
             AND trim(source.thread_id) != ''
         )`,
    ).run();
    db.prepare(
      `UPDATE project_boards
       SET source_thread_id = (
         SELECT card.source_thread_id
         FROM project_board_cards card
         WHERE card.board_id = project_boards.id
           AND card.source_thread_id IS NOT NULL
           AND trim(card.source_thread_id) != ''
         ORDER BY card.created_at ASC, card.rowid ASC
         LIMIT 1
       )
       WHERE source_thread_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM project_board_cards card
           WHERE card.board_id = project_boards.id
             AND card.source_thread_id IS NOT NULL
             AND trim(card.source_thread_id) != ''
         )`,
    ).run();
    db.prepare("DROP INDEX IF EXISTS idx_project_boards_active_project").run();
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_boards_active_project_global
       ON project_boards(project_path)
       WHERE source_thread_id IS NULL AND status IN ('draft', 'active', 'paused')`,
    ).run();
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_boards_active_project_thread
       ON project_boards(project_path, source_thread_id)
       WHERE source_thread_id IS NOT NULL AND status IN ('draft', 'active', 'paused')`,
    ).run();
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_project_boards_thread_updated ON project_boards(project_path, source_thread_id, updated_at)",
    ).run();
    db.prepare(
      `UPDATE project_boards
       SET status = 'active', updated_at = datetime('now')
       WHERE status = 'archived'
         AND source_thread_id IS NOT NULL
         AND id IN (
           SELECT latest.id
           FROM project_boards latest
           WHERE latest.status = 'archived'
             AND latest.source_thread_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM project_boards active
               WHERE active.project_path = latest.project_path
                 AND active.source_thread_id = latest.source_thread_id
                 AND active.status IN ('draft', 'active', 'paused')
             )
             AND latest.rowid = (
               SELECT candidate.rowid
               FROM project_boards candidate
               WHERE candidate.project_path = latest.project_path
                 AND candidate.source_thread_id = latest.source_thread_id
                 AND candidate.status = 'archived'
               ORDER BY candidate.updated_at DESC, candidate.rowid DESC
               LIMIT 1
             )
         )`,
    ).run();
  })();
}

export function migrateProjectStorePermissionModeDefaultsToWorkspace(db: Database.Database): void {
  db.prepare(PROJECT_STORE_DATA_MIGRATION_SQL.permissionModeSettingDefault).run(
    JSON.stringify("workspace"),
    "permissionMode",
    JSON.stringify("full-access"),
  );
  db.prepare(PROJECT_STORE_DATA_MIGRATION_SQL.permissionModeStarterThreads).run();
}

export const PROJECT_STORE_MIGRATION_COLUMN_GROUPS = {
  coreThreadSubagent: [
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
  ],
  runtimeSupport: [
    ["runs", "diagnostics_json", "TEXT"],
    ["context_usage_snapshots", "model_id", "TEXT"],
    ["message_voice_states", "last_audio_path", "TEXT"],
    ["plugin_trust", "fingerprint", "TEXT"],
    ["permission_audit", "decision_source", "TEXT"],
    ["permission_audit", "grant_id", "TEXT"],
  ],
  projectBoardCards: [
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
  ],
  projectBoardSourceMetadata: [
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
  ],
  projectBoardQuestionSynthesis: [
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
  ],
  projectBoardExecutionArtifacts: [["project_board_execution_artifacts", "source", "TEXT NOT NULL DEFAULT 'git'"]],
  projectBoardThreadScope: [["project_boards", "source_thread_id", "TEXT"]],
  automationOrchestration: [
    ["automation_schedules", "last_run_at", "TEXT"],
    ["automation_schedules", "target_version", "INTEGER"],
    ["automation_schedules", "created_target_version_id", "TEXT"],
    ["automation_schedules", "dedicated_thread_id", "TEXT"],
    ["automation_schedules", "run_limits_json", "TEXT"],
    ["automation_schedule_exceptions", "run_limits_json", "TEXT"],
    ["orchestration_tasks", "project_path", "TEXT"],
  ],
  workflowRuns: [
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
  ],
  workflowExplorationTraces: [
    ["workflow_exploration_traces", "events_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["workflow_exploration_traces", "run_status", "TEXT NOT NULL DEFAULT 'succeeded'"],
    ["workflow_exploration_traces", "graph_snapshot_id", "TEXT"],
    ["workflow_exploration_traces", "latest_progress_json", "TEXT"],
    ["workflow_exploration_traces", "provider_health_json", "TEXT"],
    ["workflow_exploration_traces", "retry_metadata_json", "TEXT"],
    ["workflow_exploration_traces", "error_message", "TEXT"],
    ["workflow_exploration_traces", "updated_at", "TEXT"],
    ["workflow_exploration_traces", "completed_at", "TEXT"],
  ],
  workflowModelCalls: [
    ["workflow_model_calls", "graph_node_id", "TEXT"],
    ["workflow_model_calls", "graph_edge_id", "TEXT"],
    ["workflow_model_calls", "item_key", "TEXT"],
    ["workflow_model_calls", "cache_checkpoint_json", "TEXT"],
  ],
  workflowDiscoveryQuestions: [
    ["workflow_discovery_questions", "provider", "TEXT"],
    ["workflow_discovery_questions", "revision_id", "TEXT"],
    ["workflow_discovery_questions", "provider_model", "TEXT"],
    ["workflow_discovery_questions", "policy_context_summary", "TEXT"],
    ["workflow_discovery_questions", "capability_search_json", "TEXT"],
    ["workflow_discovery_questions", "capability_descriptions_json", "TEXT"],
    ["workflow_discovery_questions", "blocked_reasons_json", "TEXT"],
    ["workflow_discovery_questions", "access_requests_json", "TEXT"],
    ["workflow_discovery_questions", "activity_events_json", "TEXT"],
  ],
  plannerThreadGoals: [
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
  ],
  workflowDiscoveryFinal: [
    ["workflow_discovery_questions", "cache_checkpoint_json", "TEXT"],
    ["workflow_discovery_questions", "graph_patch_json", "TEXT"],
  ],
  callableWorkflowPatternGraphs: [
    ["callable_workflow_tasks", "pattern_graph_snapshot_json", "TEXT"],
  ],
  threadWakeContinuations: [
    ["thread_wake_continuations", "operation_key", "TEXT"],
    ["thread_wake_continuations", "supersedes_wake_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["thread_wake_continuations", "resolved_at", "TEXT"],
    ["thread_wake_continuations", "resolution_reason", "TEXT"],
  ],
} as const;

export type ProjectStoreMigrationColumnGroupKey = keyof typeof PROJECT_STORE_MIGRATION_COLUMN_GROUPS;
export type ProjectStoreSchemaMigrationStep =
  | { kind: "columnGroup"; key: ProjectStoreMigrationColumnGroupKey }
  | { kind: "index"; key: ProjectStoreMigrationIndexKey }
  | { kind: "threadGoalProviderStatusCheck" }
  | { kind: "threadWakeContinuationStatusCheck" };
export const PROJECT_STORE_SCHEMA_MIGRATION_STEPS_BEFORE_ORCHESTRATION_BACKFILL: readonly ProjectStoreSchemaMigrationStep[] = [
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
] as const;

export const PROJECT_STORE_SCHEMA_MIGRATION_STEPS_AFTER_ORCHESTRATION_BACKFILL_BEFORE_PLANNER_REPAIR: readonly ProjectStoreSchemaMigrationStep[] = [
  { kind: "columnGroup", key: "workflowRuns" },
  { kind: "columnGroup", key: "workflowExplorationTraces" },
  { kind: "columnGroup", key: "workflowModelCalls" },
  { kind: "columnGroup", key: "workflowDiscoveryQuestions" },
  { kind: "columnGroup", key: "plannerThreadGoals" },
  { kind: "threadGoalProviderStatusCheck" },
] as const;

export const PROJECT_STORE_SCHEMA_MIGRATION_STEPS_AFTER_PLANNER_REPAIR: readonly ProjectStoreSchemaMigrationStep[] = [
  { kind: "columnGroup", key: "workflowDiscoveryFinal" },
  { kind: "columnGroup", key: "callableWorkflowPatternGraphs" },
  { kind: "columnGroup", key: "threadWakeContinuations" },
  { kind: "threadWakeContinuationStatusCheck" },
  { kind: "index", key: "threadWakeContinuationsOperation" },
  { kind: "index", key: "workflowDiscoveryQuestionsRevision" },
] as const;

export function applyProjectStoreSchemaMigrationSteps(
  db: Database.Database,
  steps: readonly ProjectStoreSchemaMigrationStep[],
): void {
  for (const step of steps) {
    if (step.kind === "columnGroup") {
      ensureProjectStoreColumnGroup(db, step.key);
    } else if (step.kind === "index") {
      ensureProjectStoreIndex(db, step.key);
    } else if (step.kind === "threadGoalProviderStatusCheck") {
      ensureThreadGoalProviderStatusCheck(db);
    } else {
      ensureThreadWakeContinuationStatusCheck(db);
    }
  }
}

export function ensureProjectStoreColumnGroup(db: Database.Database, key: ProjectStoreMigrationColumnGroupKey): void {
  for (const [table, column, definition] of PROJECT_STORE_MIGRATION_COLUMN_GROUPS[key]) {
    ensureProjectStoreColumn(db, table, column, definition);
  }
}

export function ensureProjectStoreColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function ensureThreadGoalProviderStatusCheck(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_goals'").get() as
    | { sql?: string }
    | undefined;
  if (!row?.sql || row.sql.includes("'provider_unavailable'")) return;
  db.exec(`
    DROP TABLE IF EXISTS thread_goals_status_migration;
    CREATE TABLE thread_goals_status_migration (
      thread_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'provider_unavailable', 'complete'
      )),
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      continuation_turns INTEGER NOT NULL DEFAULT 0,
      no_progress_turns INTEGER NOT NULL DEFAULT 0,
      provider_infra_failures INTEGER NOT NULL DEFAULT 0,
      status_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_continued_at TEXT,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    INSERT INTO thread_goals_status_migration
      (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds,
       continuation_turns, no_progress_turns, provider_infra_failures, status_reason, created_at, updated_at, completed_at, last_continued_at)
    SELECT
      thread_id,
      goal_id,
      objective,
      CASE
        WHEN status IN ('active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'provider_unavailable', 'complete')
          THEN status
        ELSE 'paused'
      END,
      token_budget,
      tokens_used,
      time_used_seconds,
      continuation_turns,
      no_progress_turns,
      provider_infra_failures,
      status_reason,
      created_at,
      updated_at,
      completed_at,
      last_continued_at
    FROM thread_goals;
    DROP TABLE thread_goals;
    ALTER TABLE thread_goals_status_migration RENAME TO thread_goals;
  `);
}

export function ensureThreadWakeContinuationStatusCheck(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_wake_continuations'").get() as
    | { sql?: string }
    | undefined;
  if (!row?.sql || row.sql.includes("'superseded'")) return;
  db.exec(`
    DROP TABLE IF EXISTS thread_wake_continuations_status_migration;
    CREATE TABLE thread_wake_continuations_status_migration (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'cancelled', 'failed', 'resolved', 'superseded')),
      reason TEXT NOT NULL,
      job_id TEXT,
      operation_key TEXT,
      supersedes_wake_ids_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      resolved_at TEXT,
      resolution_reason TEXT,
      error TEXT,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    INSERT INTO thread_wake_continuations_status_migration
      (id, thread_id, due_at, status, reason, job_id, operation_key, supersedes_wake_ids_json,
       payload_json, created_at, updated_at, delivered_at, resolved_at, resolution_reason, error)
    SELECT
      id,
      thread_id,
      due_at,
      CASE
        WHEN status IN ('pending', 'delivered', 'cancelled', 'failed', 'resolved', 'superseded')
          THEN status
        ELSE 'failed'
      END,
      reason,
      job_id,
      operation_key,
      COALESCE(supersedes_wake_ids_json, '[]'),
      payload_json,
      created_at,
      updated_at,
      delivered_at,
      resolved_at,
      resolution_reason,
      error
    FROM thread_wake_continuations;
    DROP TABLE thread_wake_continuations;
    ALTER TABLE thread_wake_continuations_status_migration RENAME TO thread_wake_continuations;
    CREATE INDEX IF NOT EXISTS idx_thread_wake_continuations_pending_due ON thread_wake_continuations(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_thread_wake_continuations_thread ON thread_wake_continuations(thread_id, status, due_at);
    CREATE INDEX IF NOT EXISTS idx_thread_wake_continuations_operation ON thread_wake_continuations(thread_id, operation_key, status, due_at);
  `);
}
