export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      audit_comments: {
        Row: {
          audit_log_id: string
          body: string
          created_at: string
          id: string
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          user_id: string
        }
        Insert: {
          audit_log_id: string
          body: string
          created_at?: string
          id?: string
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          user_id: string
        }
        Update: {
          audit_log_id?: string
          body?: string
          created_at?: string
          id?: string
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_comments_audit_log_id_fkey"
            columns: ["audit_log_id"]
            isOneToOne: false
            referencedRelation: "audit_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_comments_audit_log_id_fkey"
            columns: ["audit_log_id"]
            isOneToOne: false
            referencedRelation: "view_digest_audit_enriched"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          comment: string | null
          diff: Json | null
          id: string
          operation: string
          performed_at: string
          performed_by: string | null
          record_id: string
          resolve_request_type: string | null
          resolve_requested: boolean
          resolve_requested_at: string | null
          resolve_requested_by: string | null
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          snapshot: Json | null
          table_name: string
        }
        Insert: {
          comment?: string | null
          diff?: Json | null
          id?: string
          operation: string
          performed_at?: string
          performed_by?: string | null
          record_id: string
          resolve_request_type?: string | null
          resolve_requested?: boolean
          resolve_requested_at?: string | null
          resolve_requested_by?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          snapshot?: Json | null
          table_name?: string
        }
        Update: {
          comment?: string | null
          diff?: Json | null
          id?: string
          operation?: string
          performed_at?: string
          performed_by?: string | null
          record_id?: string
          resolve_request_type?: string | null
          resolve_requested?: boolean
          resolve_requested_at?: string | null
          resolve_requested_by?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          snapshot?: Json | null
          table_name?: string
        }
        Relationships: []
      }
      batches: {
        Row: {
          avg_cost: number | null
          batch_code: string
          created_at: string | null
          current_weight: number | null
          id: string
          location_ref: string
          notes: string | null
          quality_stats: Json | null
          status: Database["public"]["Enums"]["batch_status"] | null
          updated_at: string | null
        }
        Insert: {
          avg_cost?: number | null
          batch_code: string
          created_at?: string | null
          current_weight?: number | null
          id?: string
          location_ref: string
          notes?: string | null
          quality_stats?: Json | null
          status?: Database["public"]["Enums"]["batch_status"] | null
          updated_at?: string | null
        }
        Update: {
          avg_cost?: number | null
          batch_code?: string
          created_at?: string | null
          current_weight?: number | null
          id?: string
          location_ref?: string
          notes?: string | null
          quality_stats?: Json | null
          status?: Database["public"]["Enums"]["batch_status"] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      blend_proposal_versions: {
        Row: {
          blocks: Json
          change_note: string | null
          created_at: string
          created_by: string
          id: string
          parent_version_no: number | null
          proposal_id: string
          snapshot: Json
          snapshot_hash: string
          version_no: number
        }
        Insert: {
          blocks: Json
          change_note?: string | null
          created_at?: string
          created_by: string
          id?: string
          parent_version_no?: number | null
          proposal_id: string
          snapshot: Json
          snapshot_hash: string
          version_no: number
        }
        Update: {
          blocks?: Json
          change_note?: string | null
          created_at?: string
          created_by?: string
          id?: string
          parent_version_no?: number | null
          proposal_id?: string
          snapshot?: Json
          snapshot_hash?: string
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "blend_proposal_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_proposal_versions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "blend_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_proposal_versions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "view_blend_proposal_list"
            referencedColumns: ["id"]
          },
        ]
      }
      blend_proposals: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          created_at: string
          created_by: string
          current_version_no: number
          fed_on: string | null
          id: string
          notes: string | null
          row_version: number
          status: string
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          created_at?: string
          created_by: string
          current_version_no?: number
          fed_on?: string | null
          id?: string
          notes?: string | null
          row_version?: number
          status?: string
          title: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          created_at?: string
          created_by?: string
          current_version_no?: number
          fed_on?: string | null
          id?: string
          notes?: string | null
          row_version?: number
          status?: string
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "blend_proposals_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_proposals_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_proposals_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      deliveries: {
        Row: {
          batch_code: string | null
          block_loc: string | null
          cost_basis: number
          created_at: string | null
          deduction_note: string | null
          human_edited_at: string | null
          human_edited_by: string | null
          id: string
          lab_results: Json
          remarks: string | null
          sacks: number | null
          supplier: string
          transaction_date: string
          truck_plate: string | null
          true_weight_kg: number | null
          weight_kg: number
        }
        Insert: {
          batch_code?: string | null
          block_loc?: string | null
          cost_basis: number
          created_at?: string | null
          deduction_note?: string | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          lab_results?: Json
          remarks?: string | null
          sacks?: number | null
          supplier: string
          transaction_date: string
          truck_plate?: string | null
          true_weight_kg?: number | null
          weight_kg: number
        }
        Update: {
          batch_code?: string | null
          block_loc?: string | null
          cost_basis?: number
          created_at?: string | null
          deduction_note?: string | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          lab_results?: Json
          remarks?: string | null
          sacks?: number | null
          supplier?: string
          transaction_date?: string
          truck_plate?: string | null
          true_weight_kg?: number | null
          weight_kg?: number
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_digest_rcout_batch_daily"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_campaign_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_blocks_used"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_cells"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_open_blocks"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_code"]
          },
        ]
      }
      deliveries_archive: {
        Row: {
          archive_batch_id: string
          archive_id: string
          archive_reason: string
          archived_at: string
          archived_by: string | null
          batch_code: string | null
          block_loc: string | null
          context: Json | null
          cost_basis: number | null
          delivery_id: string
          restored_at: string | null
          restored_by: string | null
          row_snapshot: Json
          sacks: number | null
          supplier: string
          transaction_date: string
          truck_plate: string | null
          weight_kg: number
        }
        Insert: {
          archive_batch_id: string
          archive_id?: string
          archive_reason: string
          archived_at?: string
          archived_by?: string | null
          batch_code?: string | null
          block_loc?: string | null
          context?: Json | null
          cost_basis?: number | null
          delivery_id: string
          restored_at?: string | null
          restored_by?: string | null
          row_snapshot: Json
          sacks?: number | null
          supplier: string
          transaction_date: string
          truck_plate?: string | null
          weight_kg: number
        }
        Update: {
          archive_batch_id?: string
          archive_id?: string
          archive_reason?: string
          archived_at?: string
          archived_by?: string | null
          batch_code?: string | null
          block_loc?: string | null
          context?: Json | null
          cost_basis?: number | null
          delivery_id?: string
          restored_at?: string | null
          restored_by?: string | null
          row_snapshot?: Json
          sacks?: number | null
          supplier?: string
          transaction_date?: string
          truck_plate?: string | null
          weight_kg?: number
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_archive_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_archive_restored_by_fkey"
            columns: ["restored_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_source_aliases: {
        Row: {
          active: boolean
          confirmed_by: string | null
          created_at: string
          evidence: string
          first_seen_on: string | null
          id: string
          kind: string
          last_seen_at: string
          ours: string
          ours_raw: string | null
          theirs: string
          theirs_raw: string | null
          times_seen: number
        }
        Insert: {
          active?: boolean
          confirmed_by?: string | null
          created_at?: string
          evidence: string
          first_seen_on?: string | null
          id?: string
          kind: string
          last_seen_at?: string
          ours: string
          ours_raw?: string | null
          theirs: string
          theirs_raw?: string | null
          times_seen?: number
        }
        Update: {
          active?: boolean
          confirmed_by?: string | null
          created_at?: string
          evidence?: string
          first_seen_on?: string | null
          id?: string
          kind?: string
          last_seen_at?: string
          ours?: string
          ours_raw?: string | null
          theirs?: string
          theirs_raw?: string | null
          times_seen?: number
        }
        Relationships: [
          {
            foreignKeyName: "delivery_source_aliases_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      electricity_readings: {
        Row: {
          consumption_kwh: number | null
          created_at: string
          diff_kwh: number | null
          end_kwh: number
          human_edited_at: string | null
          human_edited_by: string | null
          id: string
          meter: string
          meter_multiplier: number
          reading_date: string
          remarks: string | null
          start_kwh: number
        }
        Insert: {
          consumption_kwh?: number | null
          created_at?: string
          diff_kwh?: number | null
          end_kwh: number
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          meter: string
          meter_multiplier?: number
          reading_date: string
          remarks?: string | null
          start_kwh: number
        }
        Update: {
          consumption_kwh?: number | null
          created_at?: string
          diff_kwh?: number | null
          end_kwh?: number
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          meter?: string
          meter_multiplier?: number
          reading_date?: string
          remarks?: string | null
          start_kwh?: number
        }
        Relationships: [
          {
            foreignKeyName: "electricity_readings_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      flecon_bag_date_settlements: {
        Row: {
          db_movement_count: number
          db_net_qty: number
          note: string | null
          reason: string
          settled_at: string
          settled_by_audit_log_id: string | null
          settled_by_run_id: string | null
          transaction_date: string
        }
        Insert: {
          db_movement_count: number
          db_net_qty: number
          note?: string | null
          reason?: string
          settled_at?: string
          settled_by_audit_log_id?: string | null
          settled_by_run_id?: string | null
          transaction_date: string
        }
        Update: {
          db_movement_count?: number
          db_net_qty?: number
          note?: string | null
          reason?: string
          settled_at?: string
          settled_by_audit_log_id?: string | null
          settled_by_run_id?: string | null
          transaction_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "flecon_bag_date_settlements_settled_by_audit_log_id_fkey"
            columns: ["settled_by_audit_log_id"]
            isOneToOne: false
            referencedRelation: "audit_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flecon_bag_date_settlements_settled_by_audit_log_id_fkey"
            columns: ["settled_by_audit_log_id"]
            isOneToOne: false
            referencedRelation: "view_digest_audit_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flecon_bag_date_settlements_settled_by_run_id_fkey"
            columns: ["settled_by_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      flecon_bag_movements: {
        Row: {
          bag_type_id: string
          created_at: string
          id: string
          particular: string | null
          qty_delta: number
          remarks: string | null
          source_row: number | null
          transaction_date: string
        }
        Insert: {
          bag_type_id: string
          created_at?: string
          id?: string
          particular?: string | null
          qty_delta: number
          remarks?: string | null
          source_row?: number | null
          transaction_date: string
        }
        Update: {
          bag_type_id?: string
          created_at?: string
          id?: string
          particular?: string | null
          qty_delta?: number
          remarks?: string | null
          source_row?: number | null
          transaction_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "flecon_bag_movements_bag_type_id_fkey"
            columns: ["bag_type_id"]
            isOneToOne: false
            referencedRelation: "flecon_bag_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flecon_bag_movements_bag_type_id_fkey"
            columns: ["bag_type_id"]
            isOneToOne: false
            referencedRelation: "view_flecon_bag_balance"
            referencedColumns: ["bag_type_id"]
          },
        ]
      }
      flecon_bag_opening_balances: {
        Row: {
          bag_type_id: string
          id: string
          qty: number
          year: number
        }
        Insert: {
          bag_type_id: string
          id?: string
          qty?: number
          year: number
        }
        Update: {
          bag_type_id?: string
          id?: string
          qty?: number
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "flecon_bag_opening_balances_bag_type_id_fkey"
            columns: ["bag_type_id"]
            isOneToOne: false
            referencedRelation: "flecon_bag_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flecon_bag_opening_balances_bag_type_id_fkey"
            columns: ["bag_type_id"]
            isOneToOne: false
            referencedRelation: "view_flecon_bag_balance"
            referencedColumns: ["bag_type_id"]
          },
        ]
      }
      flecon_bag_types: {
        Row: {
          active: boolean
          capacity_kls: number | null
          code: string
          color: string | null
          id: string
          label: string
          material: string | null
          nickname: string | null
          notes: string | null
          sort_order: number | null
          source_column: string | null
          source_label: string | null
        }
        Insert: {
          active?: boolean
          capacity_kls?: number | null
          code: string
          color?: string | null
          id?: string
          label: string
          material?: string | null
          nickname?: string | null
          notes?: string | null
          sort_order?: number | null
          source_column?: string | null
          source_label?: string | null
        }
        Update: {
          active?: boolean
          capacity_kls?: number | null
          code?: string
          color?: string | null
          id?: string
          label?: string
          material?: string | null
          nickname?: string | null
          notes?: string | null
          sort_order?: number | null
          source_column?: string | null
          source_label?: string | null
        }
        Relationships: []
      }
      ingestion_watermarks: {
        Row: {
          last_email_id: string | null
          last_email_received_at: string | null
          last_run_at: string
          report_type: string
        }
        Insert: {
          last_email_id?: string | null
          last_email_received_at?: string | null
          last_run_at?: string
          report_type: string
        }
        Update: {
          last_email_id?: string | null
          last_email_received_at?: string | null
          last_run_at?: string
          report_type?: string
        }
        Relationships: []
      }
      jarvis_conversations: {
        Row: {
          archived: boolean
          created_at: string
          id: string
          last_message_at: string
          title: string | null
          user_id: string
        }
        Insert: {
          archived?: boolean
          created_at?: string
          id?: string
          last_message_at?: string
          title?: string | null
          user_id: string
        }
        Update: {
          archived?: boolean
          created_at?: string
          id?: string
          last_message_at?: string
          title?: string | null
          user_id?: string
        }
        Relationships: []
      }
      jarvis_learnings: {
        Row: {
          content: string
          created_at: string
          id: string
          last_used_at: string | null
          source_message_id: string | null
          type: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          last_used_at?: string | null
          source_message_id?: string | null
          type: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          last_used_at?: string | null
          source_message_id?: string | null
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "jarvis_learnings_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "jarvis_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      jarvis_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          position: number
          role: string
          tool_calls: Json | null
          tool_results: Json | null
        }
        Insert: {
          content?: string
          conversation_id: string
          created_at?: string
          id?: string
          position?: number
          role: string
          tool_calls?: Json | null
          tool_results?: Json | null
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          position?: number
          role?: string
          tool_calls?: Json | null
          tool_results?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "jarvis_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "jarvis_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_subscriptions: {
        Row: {
          audit_log_id: string
          created_at: string | null
          id: string
          user_id: string
        }
        Insert: {
          audit_log_id: string
          created_at?: string | null
          id?: string
          user_id: string
        }
        Update: {
          audit_log_id?: string
          created_at?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_subscriptions_audit_log_id_fkey"
            columns: ["audit_log_id"]
            isOneToOne: false
            referencedRelation: "audit_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_subscriptions_audit_log_id_fkey"
            columns: ["audit_log_id"]
            isOneToOne: false
            referencedRelation: "view_digest_audit_enriched"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          archived: boolean | null
          body: string | null
          created_at: string | null
          id: string
          metadata: Json | null
          read: boolean | null
          read_at: string | null
          source_user_id: string | null
          title: string
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Insert: {
          archived?: boolean | null
          body?: string | null
          created_at?: string | null
          id?: string
          metadata?: Json | null
          read?: boolean | null
          read_at?: string | null
          source_user_id?: string | null
          title: string
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Update: {
          archived?: boolean | null
          body?: string | null
          created_at?: string | null
          id?: string
          metadata?: Json | null
          read?: boolean | null
          read_at?: string | null
          source_user_id?: string | null
          title?: string
          type?: Database["public"]["Enums"]["notification_type"]
          user_id?: string
        }
        Relationships: []
      }
      pending_review: {
        Row: {
          commit_audit_log_id: string | null
          diagnostic_json: Json | null
          extracted_at: string
          final_rows_json: Json | null
          id: string
          overall_confidence: number | null
          received_at: string | null
          report_type: string
          reviewed_at: string | null
          reviewed_by: string | null
          rows_json: Json
          source_attachment_id: string | null
          source_email_id: string
          source_filename: string | null
          status: string
        }
        Insert: {
          commit_audit_log_id?: string | null
          diagnostic_json?: Json | null
          extracted_at?: string
          final_rows_json?: Json | null
          id?: string
          overall_confidence?: number | null
          received_at?: string | null
          report_type: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          rows_json: Json
          source_attachment_id?: string | null
          source_email_id: string
          source_filename?: string | null
          status?: string
        }
        Update: {
          commit_audit_log_id?: string | null
          diagnostic_json?: Json | null
          extracted_at?: string
          final_rows_json?: Json | null
          id?: string
          overall_confidence?: number | null
          received_at?: string | null
          report_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          rows_json?: Json
          source_attachment_id?: string | null
          source_email_id?: string
          source_filename?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_review_commit_audit_log_id_fkey"
            columns: ["commit_audit_log_id"]
            isOneToOne: false
            referencedRelation: "audit_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_review_commit_audit_log_id_fkey"
            columns: ["commit_audit_log_id"]
            isOneToOne: false
            referencedRelation: "view_digest_audit_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_review_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      product_grade_openings: {
        Row: {
          as_of: string | null
          flecs: number
          grade_id: string
          stage: string
        }
        Insert: {
          as_of?: string | null
          flecs: number
          grade_id: string
          stage: string
        }
        Update: {
          as_of?: string | null
          flecs?: number
          grade_id?: string
          stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_grade_openings_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "product_grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_grade_openings_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "view_product_onhand"
            referencedColumns: ["grade_id"]
          },
          {
            foreignKeyName: "product_grade_openings_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "view_product_stage_balance"
            referencedColumns: ["grade_id"]
          },
        ]
      }
      product_grades: {
        Row: {
          active: boolean
          aliases: string[]
          code: string
          content_fingerprint: string | null
          created_at: string
          display_name: string
          first_seen_at: string
          id: string
          last_seen_at: string
          opening_as_of: string | null
          sheet_name: string
          sort_order: number
          thresholds: Json
          updated_at: string
        }
        Insert: {
          active?: boolean
          aliases?: string[]
          code: string
          content_fingerprint?: string | null
          created_at?: string
          display_name: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          opening_as_of?: string | null
          sheet_name: string
          sort_order?: number
          thresholds?: Json
          updated_at?: string
        }
        Update: {
          active?: boolean
          aliases?: string[]
          code?: string
          content_fingerprint?: string | null
          created_at?: string
          display_name?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          opening_as_of?: string | null
          sheet_name?: string
          sort_order?: number
          thresholds?: Json
          updated_at?: string
        }
        Relationships: []
      }
      product_movements: {
        Row: {
          created_at: string
          flec_delta: number
          grade_id: string
          id: string
          kg_delta: number | null
          remarks: string | null
          row_hash: string
          sheet_running: Json | null
          source_row: number
          stage: string
          transaction_date: string
        }
        Insert: {
          created_at?: string
          flec_delta: number
          grade_id: string
          id?: string
          kg_delta?: number | null
          remarks?: string | null
          row_hash: string
          sheet_running?: Json | null
          source_row: number
          stage: string
          transaction_date: string
        }
        Update: {
          created_at?: string
          flec_delta?: number
          grade_id?: string
          id?: string
          kg_delta?: number | null
          remarks?: string | null
          row_hash?: string
          sheet_running?: Json | null
          source_row?: number
          stage?: string
          transaction_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_movements_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "product_grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_movements_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "view_product_onhand"
            referencedColumns: ["grade_id"]
          },
          {
            foreignKeyName: "product_movements_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "view_product_stage_balance"
            referencedColumns: ["grade_id"]
          },
        ]
      }
      production_downtime: {
        Row: {
          created_at: string
          dt_hrs: number
          dt_incident_ranges: string | null
          dt_mins: number
          dt_ranges: string | null
          dt_reason: string | null
          human_edited_at: string | null
          human_edited_by: string | null
          id: string
          shift_hrs: number
          shift_hrs_source: string | null
          shift_id: string
        }
        Insert: {
          created_at?: string
          dt_hrs?: number
          dt_incident_ranges?: string | null
          dt_mins?: number
          dt_ranges?: string | null
          dt_reason?: string | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          shift_hrs: number
          shift_hrs_source?: string | null
          shift_id: string
        }
        Update: {
          created_at?: string
          dt_hrs?: number
          dt_incident_ranges?: string | null
          dt_mins?: number
          dt_ranges?: string | null
          dt_reason?: string | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          shift_hrs?: number
          shift_hrs_source?: string | null
          shift_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_downtime_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_downtime_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: true
            referencedRelation: "production_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_downtime_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: true
            referencedRelation: "view_ops_ledger_shift"
            referencedColumns: ["shift_id"]
          },
          {
            foreignKeyName: "production_downtime_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: true
            referencedRelation: "view_production_daily"
            referencedColumns: ["shift_id"]
          },
        ]
      }
      production_runs: {
        Row: {
          created_at: string
          customer: string
          grade: string
          human_edited_at: string | null
          human_edited_by: string | null
          id: string
          remarks: string | null
          sacks_bags: number | null
          shift_id: string
          ttl_kg: number
        }
        Insert: {
          created_at?: string
          customer?: string
          grade: string
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          remarks?: string | null
          sacks_bags?: number | null
          shift_id: string
          ttl_kg: number
        }
        Update: {
          created_at?: string
          customer?: string
          grade?: string
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          remarks?: string | null
          sacks_bags?: number | null
          shift_id?: string
          ttl_kg?: number
        }
        Relationships: [
          {
            foreignKeyName: "production_runs_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_runs_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "production_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_runs_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_shift"
            referencedColumns: ["shift_id"]
          },
          {
            foreignKeyName: "production_runs_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "view_production_daily"
            referencedColumns: ["shift_id"]
          },
        ]
      }
      production_setups: {
        Row: {
          active: boolean
          code: string
          created_at: string
          created_by: string | null
          grade_mix: Json
          id: string
          label: string | null
          notes: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          created_by?: string | null
          grade_mix: Json
          id?: string
          label?: string | null
          notes?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          created_by?: string | null
          grade_mix?: Json
          id?: string
          label?: string | null
          notes?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_setups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      production_shifts: {
        Row: {
          created_at: string
          human_edited_at: string | null
          human_edited_by: string | null
          id: string
          production_batch: string
          shift: string
          transaction_date: string
        }
        Insert: {
          created_at?: string
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          production_batch: string
          shift: string
          transaction_date: string
        }
        Update: {
          created_at?: string
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          production_batch?: string
          shift?: string
          transaction_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_shifts_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      production_waste: {
        Row: {
          bf_kg: number
          created_at: string
          grit_kg: number
          human_edited_at: string | null
          human_edited_by: string | null
          id: string
          remarks: string | null
          rs1a_kg: number
          rs1b_kg: number
          rs23_kg: number
          rs5_kg: number
          shift_id: string
          trml1_kg: number
          trml2_kg: number
        }
        Insert: {
          bf_kg?: number
          created_at?: string
          grit_kg?: number
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          remarks?: string | null
          rs1a_kg?: number
          rs1b_kg?: number
          rs23_kg?: number
          rs5_kg?: number
          shift_id: string
          trml1_kg?: number
          trml2_kg?: number
        }
        Update: {
          bf_kg?: number
          created_at?: string
          grit_kg?: number
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          remarks?: string | null
          rs1a_kg?: number
          rs1b_kg?: number
          rs23_kg?: number
          rs5_kg?: number
          shift_id?: string
          trml1_kg?: number
          trml2_kg?: number
        }
        Relationships: [
          {
            foreignKeyName: "production_waste_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_waste_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: true
            referencedRelation: "production_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_waste_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: true
            referencedRelation: "view_ops_ledger_shift"
            referencedColumns: ["shift_id"]
          },
          {
            foreignKeyName: "production_waste_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: true
            referencedRelation: "view_production_daily"
            referencedColumns: ["shift_id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          role: string
          status: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          role?: string
          status?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          role?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      rc_out: {
        Row: {
          batch_id: string
          block_loc: string | null
          created_at: string | null
          destination: string
          id: string
          production_batch: string | null
          remarks: string | null
          transaction_date: string
          weight_kg: number
        }
        Insert: {
          batch_id: string
          block_loc?: string | null
          created_at?: string | null
          destination: string
          id?: string
          production_batch?: string | null
          remarks?: string | null
          transaction_date: string
          weight_kg: number
        }
        Update: {
          batch_id?: string
          block_loc?: string | null
          created_at?: string | null
          destination?: string
          id?: string
          production_batch?: string | null
          remarks?: string | null
          transaction_date?: string
          weight_kg?: number
        }
        Relationships: [
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_id"]
          },
        ]
      }
      rc_out_date_settlements: {
        Row: {
          db_sum_kg: number
          movement_kg: number
          settled_at: string
          settled_by_run_id: string | null
          transaction_date: string
        }
        Insert: {
          db_sum_kg: number
          movement_kg: number
          settled_at?: string
          settled_by_run_id?: string | null
          transaction_date: string
        }
        Update: {
          db_sum_kg?: number
          movement_kg?: number
          settled_at?: string
          settled_by_run_id?: string | null
          transaction_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "rc_out_date_settlements_settled_by_run_id_fkey"
            columns: ["settled_by_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_case_messages: {
        Row: {
          case_id: string
          content: string
          created_at: string
          id: string
          position: number
          role: string
          tool_calls: Json | null
          tool_results: Json | null
        }
        Insert: {
          case_id: string
          content?: string
          created_at?: string
          id?: string
          position: number
          role: string
          tool_calls?: Json | null
          tool_results?: Json | null
        }
        Update: {
          case_id?: string
          content?: string
          created_at?: string
          id?: string
          position?: number
          role?: string
          tool_calls?: Json | null
          tool_results?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_case_messages_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "sync_held_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_case_rulings: {
        Row: {
          action: string
          case_id: string | null
          created_at: string
          fingerprint: string
          id: string
          reasoning: string | null
          ruled_by: string | null
          ruled_by_email: string | null
          verdict_summary: string
        }
        Insert: {
          action: string
          case_id?: string | null
          created_at?: string
          fingerprint: string
          id?: string
          reasoning?: string | null
          ruled_by?: string | null
          ruled_by_email?: string | null
          verdict_summary: string
        }
        Update: {
          action?: string
          case_id?: string | null
          created_at?: string
          fingerprint?: string
          id?: string
          reasoning?: string | null
          ruled_by?: string | null
          ruled_by_email?: string | null
          verdict_summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_case_rulings_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "sync_held_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_case_rulings_ruled_by_fkey"
            columns: ["ruled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_finding_acks: {
        Row: {
          acked_at: string
          acked_by: string
          action: string
          content_hash: string
          fingerprint: string
          id: string
          kind: string
          note: string | null
        }
        Insert: {
          acked_at?: string
          acked_by: string
          action: string
          content_hash: string
          fingerprint: string
          id?: string
          kind: string
          note?: string | null
        }
        Update: {
          acked_at?: string
          acked_by?: string
          action?: string
          content_hash?: string
          fingerprint?: string
          id?: string
          kind?: string
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_finding_acks_acked_by_fkey"
            columns: ["acked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_held_cases: {
        Row: {
          created_at: string
          detail: string | null
          fingerprint: string
          first_run_id: string
          id: string
          kind: string
          known_ruling_id: string | null
          last_run_id: string
          last_seen_at: string
          natural_key: string
          occurrence_count: number
          reason: string | null
          report_type: string
          row: Json | null
          status: string
          updated_at: string
          verdict: Json | null
        }
        Insert: {
          created_at?: string
          detail?: string | null
          fingerprint: string
          first_run_id: string
          id?: string
          kind: string
          known_ruling_id?: string | null
          last_run_id: string
          last_seen_at?: string
          natural_key: string
          occurrence_count?: number
          reason?: string | null
          report_type: string
          row?: Json | null
          status?: string
          updated_at?: string
          verdict?: Json | null
        }
        Update: {
          created_at?: string
          detail?: string | null
          fingerprint?: string
          first_run_id?: string
          id?: string
          kind?: string
          known_ruling_id?: string | null
          last_run_id?: string
          last_seen_at?: string
          natural_key?: string
          occurrence_count?: number
          reason?: string | null
          report_type?: string
          row?: Json | null
          status?: string
          updated_at?: string
          verdict?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_held_cases_first_run_id_fkey"
            columns: ["first_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_held_cases_known_ruling_id_fkey"
            columns: ["known_ruling_id"]
            isOneToOne: false
            referencedRelation: "sync_case_rulings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_held_cases_last_run_id_fkey"
            columns: ["last_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_run_events: {
        Row: {
          at: string
          detail: string | null
          id: number
          label: string | null
          level: string | null
          pct: number | null
          report_type: string | null
          run_id: string
          stage: string | null
        }
        Insert: {
          at?: string
          detail?: string | null
          id?: never
          label?: string | null
          level?: string | null
          pct?: number | null
          report_type?: string | null
          run_id: string
          stage?: string | null
        }
        Update: {
          at?: string
          detail?: string | null
          id?: never
          label?: string | null
          level?: string | null
          pct?: number | null
          report_type?: string | null
          run_id?: string
          stage?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_run_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_run_reports: {
        Row: {
          bytes: number | null
          contains_prices: boolean
          error: string | null
          error_count: number
          filename: string | null
          finding_count: number
          generated_at: string
          generator_version: string | null
          id: string
          ok: boolean
          run_id: string
          sheet_counts: Json
          storage_bucket: string
          storage_path: string | null
          warn_count: number
        }
        Insert: {
          bytes?: number | null
          contains_prices?: boolean
          error?: string | null
          error_count?: number
          filename?: string | null
          finding_count?: number
          generated_at?: string
          generator_version?: string | null
          id?: string
          ok?: boolean
          run_id: string
          sheet_counts?: Json
          storage_bucket?: string
          storage_path?: string | null
          warn_count?: number
        }
        Update: {
          bytes?: number | null
          contains_prices?: boolean
          error?: string | null
          error_count?: number
          filename?: string | null
          finding_count?: number
          generated_at?: string
          generator_version?: string | null
          id?: string
          ok?: boolean
          run_id?: string
          sheet_counts?: Json
          storage_bucket?: string
          storage_path?: string | null
          warn_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "sync_run_reports_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          requested_by: string | null
          result: Json | null
          started_at: string | null
          status: Database["public"]["Enums"]["sync_run_status"]
        }
        Insert: {
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          requested_by?: string | null
          result?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["sync_run_status"]
        }
        Update: {
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          requested_by?: string | null
          result?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["sync_run_status"]
        }
        Relationships: []
      }
      truck_readings: {
        Row: {
          created_at: string
          end_km: number
          fuel_liters: number | null
          human_edited_at: string | null
          human_edited_by: string | null
          id: string
          plate_no: string
          reading_date: string
          remarks: string | null
          start_km: number
          ttl_km: number | null
        }
        Insert: {
          created_at?: string
          end_km: number
          fuel_liters?: number | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          plate_no: string
          reading_date: string
          remarks?: string | null
          start_km: number
          ttl_km?: number | null
        }
        Update: {
          created_at?: string
          end_km?: number
          fuel_liters?: number | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          plate_no?: string
          reading_date?: string
          remarks?: string | null
          start_km?: number
          ttl_km?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "truck_readings_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_dashboard_prefs: {
        Row: {
          prefs: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          prefs?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          prefs?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_invites: {
        Row: {
          created_at: string | null
          email: string
          invited_by: string | null
          role: string
        }
        Insert: {
          created_at?: string | null
          email: string
          invited_by?: string | null
          role?: string
        }
        Update: {
          created_at?: string | null
          email?: string
          invited_by?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_table_settings: {
        Row: {
          id: string
          module: string
          settings: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          module?: string
          settings?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          module?: string
          settings?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      cenapro_analysis_samples: {
        Row: {
          ash: number | null
          bd: number | null
          created_at: string | null
          created_by: string | null
          grit: number | null
          id: string | null
          mc: number | null
          notes: string | null
          row_version: number | null
          sample_date: string | null
          source: string | null
          source_location_code: string | null
          updated_at: string | null
          updated_by: string | null
          whse_key: string | null
        }
        Insert: {
          ash?: number | null
          bd?: number | null
          created_at?: string | null
          created_by?: string | null
          grit?: number | null
          id?: string | null
          mc?: number | null
          notes?: string | null
          row_version?: number | null
          sample_date?: string | null
          source?: string | null
          source_location_code?: string | null
          updated_at?: string | null
          updated_by?: string | null
          whse_key?: string | null
        }
        Update: {
          ash?: number | null
          bd?: number | null
          created_at?: string | null
          created_by?: string | null
          grit?: number | null
          id?: string | null
          mc?: number | null
          notes?: string | null
          row_version?: number | null
          sample_date?: string | null
          source?: string | null
          source_location_code?: string | null
          updated_at?: string | null
          updated_by?: string | null
          whse_key?: string | null
        }
        Relationships: []
      }
      cenapro_ccc_analysis_daily: {
        Row: {
          all_kg: number | null
          coverage: number | null
          draw_count: number | null
          dvo_kg: number | null
          ex_dvo_kg: number | null
          group_count: number | null
          missing_value_count: number | null
          sample_date: string | null
          sampled_group_count: number | null
          sampled_kg: number | null
          scope: string | null
          total_kg: number | null
          wtd_ash: number | null
          wtd_ash_kg: number | null
          wtd_bd: number | null
          wtd_bd_kg: number | null
          wtd_grit: number | null
          wtd_grit_kg: number | null
          wtd_mc: number | null
          wtd_mc_kg: number | null
        }
        Relationships: []
      }
      cenapro_ccc_analysis_monthly: {
        Row: {
          all_kg: number | null
          coverage: number | null
          day_count: number | null
          draw_count: number | null
          dvo_kg: number | null
          ex_dvo_kg: number | null
          group_count: number | null
          missing_value_count: number | null
          month_key: string | null
          month_start: string | null
          sampled_group_count: number | null
          sampled_kg: number | null
          scope: string | null
          total_kg: number | null
          wtd_ash: number | null
          wtd_ash_kg: number | null
          wtd_bd: number | null
          wtd_bd_kg: number | null
          wtd_grit: number | null
          wtd_grit_kg: number | null
          wtd_mc: number | null
          wtd_mc_kg: number | null
        }
        Relationships: []
      }
      cenapro_ccc_sample_groups: {
        Row: {
          ash: number | null
          bd: number | null
          draw_count: number | null
          grit: number | null
          is_complete: boolean | null
          is_dvo: boolean | null
          is_sampled: boolean | null
          mc: number | null
          missing_metric_count: number | null
          sample_date: string | null
          sample_id: string | null
          sample_notes: string | null
          sample_row_version: number | null
          sample_source: string | null
          sample_updated_at: string | null
          sample_updated_by: string | null
          source_group: string | null
          source_location_code: string | null
          total_kg: number | null
          whse_key: string | null
        }
        Relationships: []
      }
      cenapro_grades: {
        Row: {
          code: string | null
          display_name: string | null
          expected_kg_per_bag_max: number | null
          expected_kg_per_bag_min: number | null
          sort_order: number | null
        }
        Insert: {
          code?: string | null
          display_name?: string | null
          expected_kg_per_bag_max?: number | null
          expected_kg_per_bag_min?: number | null
          sort_order?: number | null
        }
        Update: {
          code?: string | null
          display_name?: string | null
          expected_kg_per_bag_max?: number | null
          expected_kg_per_bag_min?: number | null
          sort_order?: number | null
        }
        Relationships: []
      }
      cenapro_production_event_audit: {
        Row: {
          changed: Json | null
          changed_at: string | null
          changed_by: string | null
          changed_by_role: string | null
          event_id: string | null
          id: number | null
          operation: string | null
          recv_date: string | null
          snapshot: Json | null
          source: string | null
          unique_tag: string | null
        }
        Insert: {
          changed?: Json | null
          changed_at?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          event_id?: string | null
          id?: number | null
          operation?: string | null
          recv_date?: string | null
          snapshot?: Json | null
          source?: string | null
          unique_tag?: string | null
        }
        Update: {
          changed?: Json | null
          changed_at?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          event_id?: string | null
          id?: number | null
          operation?: string | null
          recv_date?: string | null
          snapshot?: Json | null
          source?: string | null
          unique_tag?: string | null
        }
        Relationships: []
      }
      cenapro_production_events: {
        Row: {
          batch: string | null
          batch_year: number | null
          disposition_kind: string | null
          flec_count: number | null
          grade_code: string | null
          id: string | null
          partner_equipment_code: string | null
          plant_code: string | null
          prod_date: string | null
          recv_date: string | null
          shift_code: string | null
          source_location_code: string | null
          unique_tag: string | null
          warehouse_code: string | null
          weight_kg: number | null
          whse_side: string | null
        }
        Insert: {
          batch?: string | null
          batch_year?: number | null
          disposition_kind?: string | null
          flec_count?: number | null
          grade_code?: string | null
          id?: string | null
          partner_equipment_code?: string | null
          plant_code?: string | null
          prod_date?: string | null
          recv_date?: string | null
          shift_code?: string | null
          source_location_code?: string | null
          unique_tag?: string | null
          warehouse_code?: string | null
          weight_kg?: number | null
          whse_side?: string | null
        }
        Update: {
          batch?: string | null
          batch_year?: number | null
          disposition_kind?: string | null
          flec_count?: number | null
          grade_code?: string | null
          id?: string | null
          partner_equipment_code?: string | null
          plant_code?: string | null
          prod_date?: string | null
          recv_date?: string | null
          shift_code?: string | null
          source_location_code?: string | null
          unique_tag?: string | null
          warehouse_code?: string | null
          weight_kg?: number | null
          whse_side?: string | null
        }
        Relationships: []
      }
      cenapro_rc_bank_accounts: {
        Row: {
          account_label: string | null
          account_no: string | null
          active: boolean | null
          bank_active: boolean | null
          bank_code: string | null
          bank_display_name: string | null
          bank_sort_order: number | null
          created_at: string | null
          display_label: string | null
          id: string | null
          notes: string | null
          row_version: number | null
          sort_order: number | null
          updated_at: string | null
        }
        Relationships: []
      }
      cenapro_rc_banks: {
        Row: {
          active: boolean | null
          code: string | null
          created_at: string | null
          display_name: string | null
          notes: string | null
          row_version: number | null
          sort_order: number | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          code?: string | null
          created_at?: string | null
          display_name?: string | null
          notes?: string | null
          row_version?: number | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          code?: string | null
          created_at?: string | null
          display_name?: string | null
          notes?: string | null
          row_version?: number | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      cenapro_rc_deliveries: {
        Row: {
          ash: number | null
          base_price_php_kg: number | null
          bd: number | null
          created_at: string | null
          created_by: string | null
          deduction_pct: number | null
          delivery_date: string | null
          delivery_date_raw: string | null
          delivery_year: number | null
          destination_code: string | null
          destination_raw: string | null
          destination_side: string | null
          dust: number | null
          fc: number | null
          grit: number | null
          gross_weight_kg: number | null
          id: string | null
          import_flags: Json | null
          is_suspected_duplicate: boolean | null
          moisture_pct: number | null
          net_weight_kg: number | null
          permit_no: string | null
          price_adjustment_php_kg: number | null
          price_formula: string | null
          price_php_kg: number | null
          provenance: string | null
          remarks: string | null
          row_version: number | null
          sacks: number | null
          sheet_total_php: number | null
          source_row: number | null
          source_sheet: string | null
          supplier_code: string | null
          supplier_origin: string | null
          supplier_raw: string | null
          total_price_php: number | null
          truck_no: string | null
          updated_at: string | null
          updated_by: string | null
          vm: number | null
          weight_formula: string | null
        }
        Insert: {
          ash?: number | null
          base_price_php_kg?: number | null
          bd?: number | null
          created_at?: string | null
          created_by?: string | null
          deduction_pct?: number | null
          delivery_date?: string | null
          delivery_date_raw?: string | null
          delivery_year?: number | null
          destination_code?: string | null
          destination_raw?: string | null
          destination_side?: string | null
          dust?: number | null
          fc?: number | null
          grit?: number | null
          gross_weight_kg?: number | null
          id?: string | null
          import_flags?: Json | null
          is_suspected_duplicate?: boolean | null
          moisture_pct?: number | null
          net_weight_kg?: number | null
          permit_no?: string | null
          price_adjustment_php_kg?: number | null
          price_formula?: string | null
          price_php_kg?: number | null
          provenance?: string | null
          remarks?: string | null
          row_version?: number | null
          sacks?: number | null
          sheet_total_php?: number | null
          source_row?: number | null
          source_sheet?: string | null
          supplier_code?: string | null
          supplier_origin?: string | null
          supplier_raw?: string | null
          total_price_php?: number | null
          truck_no?: string | null
          updated_at?: string | null
          updated_by?: string | null
          vm?: number | null
          weight_formula?: string | null
        }
        Update: {
          ash?: number | null
          base_price_php_kg?: number | null
          bd?: number | null
          created_at?: string | null
          created_by?: string | null
          deduction_pct?: number | null
          delivery_date?: string | null
          delivery_date_raw?: string | null
          delivery_year?: number | null
          destination_code?: string | null
          destination_raw?: string | null
          destination_side?: string | null
          dust?: number | null
          fc?: number | null
          grit?: number | null
          gross_weight_kg?: number | null
          id?: string | null
          import_flags?: Json | null
          is_suspected_duplicate?: boolean | null
          moisture_pct?: number | null
          net_weight_kg?: number | null
          permit_no?: string | null
          price_adjustment_php_kg?: number | null
          price_formula?: string | null
          price_php_kg?: number | null
          provenance?: string | null
          remarks?: string | null
          row_version?: number | null
          sacks?: number | null
          sheet_total_php?: number | null
          source_row?: number | null
          source_sheet?: string | null
          supplier_code?: string | null
          supplier_origin?: string | null
          supplier_raw?: string | null
          total_price_php?: number | null
          truck_no?: string | null
          updated_at?: string | null
          updated_by?: string | null
          vm?: number | null
          weight_formula?: string | null
        }
        Relationships: []
      }
      cenapro_rc_delivery_audit: {
        Row: {
          changed: Json | null
          changed_at: string | null
          changed_by: string | null
          changed_by_role: string | null
          delivery_date: string | null
          delivery_id: string | null
          entity: string | null
          id: number | null
          operation: string | null
          sample_id: string | null
          sample_position: number | null
          snapshot: Json | null
          source: string | null
          supplier_code: string | null
          truck_no: string | null
        }
        Insert: {
          changed?: Json | null
          changed_at?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          delivery_date?: string | null
          delivery_id?: string | null
          entity?: string | null
          id?: number | null
          operation?: string | null
          sample_id?: string | null
          sample_position?: number | null
          snapshot?: Json | null
          source?: string | null
          supplier_code?: string | null
          truck_no?: string | null
        }
        Update: {
          changed?: Json | null
          changed_at?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          delivery_date?: string | null
          delivery_id?: string | null
          entity?: string | null
          id?: number | null
          operation?: string | null
          sample_id?: string | null
          sample_position?: number | null
          snapshot?: Json | null
          source?: string | null
          supplier_code?: string | null
          truck_no?: string | null
        }
        Relationships: []
      }
      cenapro_rc_delivery_rows: {
        Row: {
          ash: number | null
          base_price_php_kg: number | null
          bd: number | null
          created_at: string | null
          created_by: string | null
          deduction_pct: number | null
          delivery_date: string | null
          delivery_date_raw: string | null
          delivery_year: number | null
          destination_code: string | null
          destination_has_sides: boolean | null
          destination_kind: string | null
          destination_name: string | null
          destination_raw: string | null
          destination_side: string | null
          destination_unresolved: boolean | null
          duplicate_group_key: string | null
          duplicate_group_ordinal: number | null
          duplicate_group_size: number | null
          duplicate_peer_ids: string[] | null
          dust: number | null
          fc: number | null
          grit: number | null
          gross_weight_kg: number | null
          has_import_flags: boolean | null
          has_unresolved_flags: boolean | null
          id: string | null
          import_flag_count: number | null
          import_flags: Json | null
          import_flags_state: Json | null
          is_suspected_duplicate: boolean | null
          moisture_pct: number | null
          net_weight_kg: number | null
          permit_no: string | null
          price_adjustment_php_kg: number | null
          price_formula: string | null
          price_php_kg: number | null
          provenance: string | null
          remarks: string | null
          resolved_flag_count: number | null
          row_version: number | null
          sacks: number | null
          sample_avg_moisture_pct: number | null
          sample_count: number | null
          sheet_total_matches: boolean | null
          sheet_total_php: number | null
          source_row: number | null
          source_sheet: string | null
          supplier_code: string | null
          supplier_name: string | null
          supplier_origin: string | null
          supplier_raw: string | null
          supplier_unresolved: boolean | null
          total_price_php: number | null
          truck_no: string | null
          unresolved_flag_count: number | null
          updated_at: string | null
          updated_by: string | null
          vm: number | null
          weight_formula: string | null
        }
        Relationships: []
      }
      cenapro_rc_delivery_samples: {
        Row: {
          ash: number | null
          bd: number | null
          created_at: string | null
          delivery_id: string | null
          dust: number | null
          fc: number | null
          grit: number | null
          id: string | null
          label: string | null
          moisture_pct: number | null
          position: number | null
          source_row: number | null
          vm: number | null
        }
        Insert: {
          ash?: number | null
          bd?: number | null
          created_at?: string | null
          delivery_id?: string | null
          dust?: number | null
          fc?: number | null
          grit?: number | null
          id?: string | null
          label?: string | null
          moisture_pct?: number | null
          position?: number | null
          source_row?: number | null
          vm?: number | null
        }
        Update: {
          ash?: number | null
          bd?: number | null
          created_at?: string | null
          delivery_id?: string | null
          dust?: number | null
          fc?: number | null
          grit?: number | null
          id?: string | null
          label?: string | null
          moisture_pct?: number | null
          position?: number | null
          source_row?: number | null
          vm?: number | null
        }
        Relationships: []
      }
      cenapro_rc_delivery_settlement: {
        Row: {
          allocated_php: number | null
          allocation_count: number | null
          balance_php: number | null
          delivery_date: string | null
          delivery_id: string | null
          destination_code: string | null
          group_code: string | null
          group_display_name: string | null
          is_allocatable: boolean | null
          is_priceable: boolean | null
          last_allocated_at: string | null
          net_weight_kg: number | null
          payment_ids: string[] | null
          row_version: number | null
          settlement_status: string | null
          supplier_code: string | null
          supplier_display_name: string | null
          total_price_php: number | null
          truck_no: string | null
        }
        Relationships: []
      }
      cenapro_rc_destinations: {
        Row: {
          active: boolean | null
          code: string | null
          created_at: string | null
          display_name: string | null
          has_sides: boolean | null
          kind: string | null
          notes: string | null
          sort_order: number | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          code?: string | null
          created_at?: string | null
          display_name?: string | null
          has_sides?: boolean | null
          kind?: string | null
          notes?: string | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          code?: string | null
          created_at?: string | null
          display_name?: string | null
          has_sides?: boolean | null
          kind?: string | null
          notes?: string | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      cenapro_rc_payment_allocations: {
        Row: {
          amount_php: number | null
          cheque_no: string | null
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          delivery_date: string | null
          delivery_id: string | null
          delivery_supplier_code: string | null
          delivery_supplier_name: string | null
          delivery_total_php: number | null
          id: string | null
          is_deleted: boolean | null
          is_subgroup_allocation: boolean | null
          method: string | null
          note: string | null
          payee_group_code: string | null
          payment_amount_php: number | null
          payment_date: string | null
          payment_id: string | null
          payment_is_deleted: boolean | null
          payment_supplier_code: string | null
          payment_supplier_name: string | null
          row_version: number | null
          truck_no: string | null
          updated_at: string | null
          updated_by: string | null
        }
        Relationships: []
      }
      cenapro_rc_payment_audit: {
        Row: {
          allocation_id: string | null
          amount_php: number | null
          changed: Json | null
          changed_at: string | null
          changed_by: string | null
          changed_by_role: string | null
          cheque_no: string | null
          delivery_id: string | null
          entity: string | null
          id: number | null
          method: string | null
          operation: string | null
          payment_date: string | null
          payment_id: string | null
          snapshot: Json | null
          source: string | null
          supplier_code: string | null
        }
        Insert: {
          allocation_id?: string | null
          amount_php?: number | null
          changed?: Json | null
          changed_at?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          cheque_no?: string | null
          delivery_id?: string | null
          entity?: string | null
          id?: number | null
          method?: string | null
          operation?: string | null
          payment_date?: string | null
          payment_id?: string | null
          snapshot?: Json | null
          source?: string | null
          supplier_code?: string | null
        }
        Update: {
          allocation_id?: string | null
          amount_php?: number | null
          changed?: Json | null
          changed_at?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          cheque_no?: string | null
          delivery_id?: string | null
          entity?: string | null
          id?: number | null
          method?: string | null
          operation?: string | null
          payment_date?: string | null
          payment_id?: string | null
          snapshot?: Json | null
          source?: string | null
          supplier_code?: string | null
        }
        Relationships: []
      }
      cenapro_rc_payment_state: {
        Row: {
          account_label: string | null
          account_no: string | null
          allocated_php: number | null
          allocation_count: number | null
          amount_php: number | null
          balance_effect_php: number | null
          bank_account_id: string | null
          bank_account_label: string | null
          bank_code: string | null
          bank_display_name: string | null
          cheque_date: string | null
          cheque_no: string | null
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          direction: string | null
          group_code: string | null
          group_display_name: string | null
          id: string | null
          is_advance: boolean | null
          is_cash: boolean | null
          is_deleted: boolean | null
          method: string | null
          payment_date: string | null
          reference_no: string | null
          remarks: string | null
          row_version: number | null
          stated_term: string | null
          supplier_code: string | null
          supplier_name: string | null
          unallocated_php: number | null
          updated_at: string | null
          updated_by: string | null
        }
        Relationships: []
      }
      cenapro_rc_payments: {
        Row: {
          account_label: string | null
          account_no: string | null
          amount_php: number | null
          balance_effect_php: number | null
          bank_account_id: string | null
          bank_account_label: string | null
          bank_code: string | null
          bank_display_name: string | null
          cheque_date: string | null
          cheque_no: string | null
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          direction: string | null
          group_code: string | null
          group_display_name: string | null
          id: string | null
          is_cash: boolean | null
          is_deleted: boolean | null
          method: string | null
          payment_date: string | null
          reference_no: string | null
          remarks: string | null
          row_version: number | null
          stated_term: string | null
          supplier_code: string | null
          supplier_name: string | null
          updated_at: string | null
          updated_by: string | null
        }
        Relationships: []
      }
      cenapro_rc_supplier_audit: {
        Row: {
          changed: Json | null
          changed_at: string | null
          changed_by: string | null
          changed_by_role: string | null
          display_name: string | null
          id: number | null
          operation: string | null
          parent_code: string | null
          snapshot: Json | null
          source: string | null
          supplier_code: string | null
        }
        Insert: {
          changed?: Json | null
          changed_at?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          display_name?: string | null
          id?: number | null
          operation?: string | null
          parent_code?: string | null
          snapshot?: Json | null
          source?: string | null
          supplier_code?: string | null
        }
        Update: {
          changed?: Json | null
          changed_at?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          display_name?: string | null
          id?: number | null
          operation?: string | null
          parent_code?: string | null
          snapshot?: Json | null
          source?: string | null
          supplier_code?: string | null
        }
        Relationships: []
      }
      cenapro_rc_supplier_balances: {
        Row: {
          active: boolean | null
          adjustment_all_php: number | null
          adjustment_count: number | null
          adjustment_count_all: number | null
          adjustment_php: number | null
          advance_payment_count: number | null
          advance_php: number | null
          advance_php_window: number | null
          carried_payment_count: number | null
          carried_payment_php: number | null
          carried_receipt_count: number | null
          carried_receipt_php: number | null
          cash_in_all_php: number | null
          cash_in_php: number | null
          cash_net_all_php: number | null
          cash_net_php: number | null
          cash_out_all_php: number | null
          cash_out_php: number | null
          display_name: string | null
          first_payment_date: string | null
          first_receipt_date: string | null
          group_code: string | null
          group_display_name: string | null
          group_sort_order: number | null
          has_opening_balance: boolean | null
          is_child: boolean | null
          is_parent: boolean | null
          is_unassigned: boolean | null
          last_payment_date: string | null
          last_receipt_date: string | null
          opening_as_of_date: string | null
          opening_balance_php: number | null
          opening_note: string | null
          opening_revision_count: number | null
          opening_revision_id: number | null
          opening_set_at: string | null
          parent_code: string | null
          payment_count: number | null
          payment_count_all: number | null
          payments_all_php: number | null
          payments_php: number | null
          receipt_count: number | null
          receipt_count_all: number | null
          receipts_all_php: number | null
          receipts_php: number | null
          running_balance_all_php: number | null
          running_balance_php: number | null
          sort_order: number | null
          supplier_code: string | null
          unassigned_incoming_php: number | null
          unpriced_awaiting_both_count: number | null
          unpriced_awaiting_price_count: number | null
          unpriced_awaiting_weight_count: number | null
          unpriced_receipt_count: number | null
          unpriced_receipt_count_window: number | null
          unpriced_receipt_kg: number | null
          unpriced_receipt_kg_window: number | null
        }
        Relationships: []
      }
      cenapro_rc_supplier_group_balances: {
        Row: {
          adjustment_all_php: number | null
          adjustment_count: number | null
          adjustment_count_all: number | null
          adjustment_php: number | null
          advance_payment_count: number | null
          advance_php: number | null
          advance_php_window: number | null
          any_active: boolean | null
          carried_payment_count: number | null
          carried_payment_php: number | null
          carried_receipt_count: number | null
          carried_receipt_php: number | null
          cash_in_all_php: number | null
          cash_in_php: number | null
          cash_net_all_php: number | null
          cash_net_php: number | null
          cash_out_all_php: number | null
          cash_out_php: number | null
          child_count: number | null
          first_payment_date: string | null
          first_receipt_date: string | null
          group_code: string | null
          group_display_name: string | null
          group_sort_order: number | null
          has_opening_balance: boolean | null
          is_unassigned: boolean | null
          last_payment_date: string | null
          last_receipt_date: string | null
          opening_as_of_date: string | null
          opening_as_of_date_max: string | null
          opening_as_of_date_min: string | null
          opening_balance_php: number | null
          opening_supplier_count: number | null
          payment_count: number | null
          payment_count_all: number | null
          payments_all_php: number | null
          payments_php: number | null
          receipt_count: number | null
          receipt_count_all: number | null
          receipts_all_php: number | null
          receipts_php: number | null
          running_balance_all_php: number | null
          running_balance_php: number | null
          supplier_codes: string[] | null
          supplier_count: number | null
          unassigned_incoming_php: number | null
          unpriced_awaiting_both_count: number | null
          unpriced_awaiting_price_count: number | null
          unpriced_awaiting_weight_count: number | null
          unpriced_receipt_count: number | null
          unpriced_receipt_count_window: number | null
          unpriced_receipt_kg: number | null
          unpriced_receipt_kg_window: number | null
        }
        Relationships: []
      }
      cenapro_rc_supplier_groups: {
        Row: {
          active: boolean | null
          child_codes: string[] | null
          child_count: number | null
          code: string | null
          created_at: string | null
          display_name: string | null
          group_code: string | null
          group_display_name: string | null
          group_sort_order: number | null
          is_child: boolean | null
          is_parent: boolean | null
          notes: string | null
          parent_code: string | null
          parent_display_name: string | null
          row_version: number | null
          sort_order: number | null
          updated_at: string | null
        }
        Relationships: []
      }
      cenapro_rc_supplier_opening_balance_history: {
        Row: {
          as_of_date: string | null
          created_at: string | null
          created_by: string | null
          id: number | null
          is_current: boolean | null
          note: string | null
          opening_balance_php: number | null
          supplier_code: string | null
          supplier_display_name: string | null
        }
        Relationships: []
      }
      cenapro_rc_supplier_opening_balances: {
        Row: {
          as_of_date: string | null
          group_code: string | null
          group_display_name: string | null
          note: string | null
          opening_balance_php: number | null
          revision_count: number | null
          revision_id: number | null
          set_at: string | null
          set_by: string | null
          supplier_code: string | null
          supplier_display_name: string | null
        }
        Relationships: []
      }
      cenapro_rc_suppliers: {
        Row: {
          active: boolean | null
          code: string | null
          created_at: string | null
          display_name: string | null
          notes: string | null
          sort_order: number | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          code?: string | null
          created_at?: string | null
          display_name?: string | null
          notes?: string | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          code?: string | null
          created_at?: string | null
          display_name?: string | null
          notes?: string | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      view_analytics_aging_eom: {
        Row: {
          as_of_date: string | null
          batches_over_120d: number | null
          closed_residue_batches: number | null
          closed_residue_kg: number | null
          is_partial_month: boolean | null
          kg_over_120d: number | null
          kg_over_60d: number | null
          month: number | null
          month_start: string | null
          oldest_age_days: number | null
          open_batches: number | null
          open_kg: number | null
          pct_over_120d: number | null
          pct_over_60d: number | null
          wtd_age_days: number | null
          year: number | null
        }
        Relationships: []
      }
      view_analytics_aging_watchlist: {
        Row: {
          age_days: number | null
          as_of_date: string | null
          balance_kg: number | null
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          days_since_last_delivery: number | null
          delivered_kg: number | null
          delivered_php_kg: number | null
          delivery_count: number | null
          fed_kg_to_date: number | null
          first_delivery_date: string | null
          has_been_fed: boolean | null
          has_unpriced_delivery: boolean | null
          last_delivery_date: string | null
          last_fed_date: string | null
          status: Database["public"]["Enums"]["batch_status"] | null
          unpriced_delivery_count: number | null
          value_php: number | null
        }
        Relationships: []
      }
      view_analytics_batch_cost: {
        Row: {
          actual_fed_php_kg: number | null
          blocks_closed: number | null
          blocks_closed_unpriced: number | null
          blocks_fed: number | null
          blocks_in_price: number | null
          blocks_open: number | null
          blocks_with_sundry: number | null
          campaign_fed_kg_excluded: number | null
          campaign_fed_kg_included: number | null
          campaign_fed_kg_included_pct: number | null
          campaign_label: string | null
          campaign_weighted_actual_fed_php_kg: number | null
          campaign_year: number | null
          delivered_php_kg: number | null
          delivered_php_kg_fed: number | null
          fed_kg: number | null
          fed_kg_price_traceable: number | null
          fed_kg_price_untraceable: number | null
          fed_price_coverage_pct: number | null
          fed_value_php: number | null
          feed_days: number | null
          first_fed_date: string | null
          is_fully_covered: boolean | null
          last_fed_date: string | null
          loss_pct: number | null
          out_kg: number | null
          php_per_produced_kg_delivered: number | null
          php_per_produced_kg_true: number | null
          process_loss_kg: number | null
          produced_kg: number | null
          production_batch: string | null
          sundry_kg: number | null
          uplift_php_kg: number | null
          weight_lost_kg: number | null
          yield_pct: number | null
        }
        Relationships: []
      }
      view_analytics_cost_monthly: {
        Row: {
          as_of_date: string | null
          closed_blocks_count: number | null
          closed_blocks_delivered_kg: number | null
          closed_blocks_delivered_php_kg: number | null
          closed_blocks_fed_kg: number | null
          closed_blocks_in_price: number | null
          closed_blocks_loss_pct: number | null
          closed_blocks_lost_kg: number | null
          closed_blocks_no_delivery: number | null
          closed_blocks_out_kg: number | null
          closed_blocks_priced_fed_kg: number | null
          closed_blocks_sundry_kg: number | null
          closed_blocks_true_php_kg: number | null
          closed_blocks_unpriced: number | null
          closed_blocks_uplift_php_kg: number | null
          closed_blocks_with_sundry: number | null
          delivered_php_kg_fed: number | null
          delivered_php_kg_fed_covered: number | null
          fed_kg: number | null
          fed_kg_price_traceable: number | null
          fed_kg_price_untraceable: number | null
          fed_price_coverage_pct: number | null
          fed_value_php: number | null
          is_partial_month: boolean | null
          month: number | null
          month_start: string | null
          php_per_produced_kg: number | null
          php_per_produced_kg_covered: number | null
          process_loss_kg: number | null
          produced_kg: number | null
          year: number | null
          yield_pct: number | null
        }
        Relationships: []
      }
      view_analytics_flow_monthly: {
        Row: {
          as_of_date: string | null
          delivery_count: number | null
          feeding_count: number | null
          in_kg: number | null
          in_per_working_day: number | null
          is_partial_month: boolean | null
          month: number | null
          month_start: string | null
          net_kg: number | null
          out_kg: number | null
          out_per_working_day: number | null
          working_days: number | null
          year: number | null
        }
        Relationships: []
      }
      view_analytics_inventory_eom: {
        Row: {
          active_batches: number | null
          all_positive_avg_unit_cost_php_kg: number | null
          as_of_date: string | null
          avg_unit_cost_php_kg: number | null
          batches_with_balance: number | null
          closed_residue_kg: number | null
          closed_residue_php_kg: number | null
          closed_residue_value_php: number | null
          ending_kg: number | null
          ending_value_php: number | null
          is_partial_month: boolean | null
          month: number | null
          month_start: string | null
          negative_balance_kg: number | null
          negative_batch_count: number | null
          out_kg: number | null
          out_per_working_day: number | null
          outflow_recorded: boolean | null
          positive_balance_kg: number | null
          runway_days: number | null
          unvalued_kg: number | null
          value_coverage_pct: number | null
          valued_kg: number | null
          working_days: number | null
          year: number | null
        }
        Relationships: []
      }
      view_analytics_production_by_batch: {
        Row: {
          campaign_label: string | null
          campaign_year: number | null
          downtime_hrs: number | null
          downtime_shift_count: number | null
          downtime_shifts_reason_only: number | null
          downtime_shifts_with_duration: number | null
          fed_kg: number | null
          first_reported_date: string | null
          kwh: number | null
          kwh_days: number | null
          kwh_meter_count: number | null
          kwh_per_produced_kg: number | null
          kwh_per_produced_kg_excl_suspect: number | null
          kwh_suspect: number | null
          kwh_suspect_reading_count: number | null
          kwh_unmapped_pre_campaign: number | null
          last_reported_date: string | null
          produced_kg: number | null
          produced_per_reported_day: number | null
          production_batch: string | null
          production_reported: boolean | null
          reported_days: number | null
          run_count: number | null
          runs_with_sacks: number | null
          sacks: number | null
          sacks_coverage_pct: number | null
          shift_count: number | null
          yield_pct: number | null
        }
        Relationships: []
      }
      view_analytics_production_grade_by_batch: {
        Row: {
          campaign_label: string | null
          campaign_produced_kg: number | null
          campaign_year: number | null
          grade: string | null
          kg: number | null
          production_batch: string | null
          run_count: number | null
          runs_with_sacks: number | null
          sacks: number | null
          share_of_campaign_pct: number | null
        }
        Relationships: []
      }
      view_analytics_production_grade_monthly: {
        Row: {
          grade: string | null
          kg: number | null
          month: number | null
          month_produced_kg: number | null
          month_start: string | null
          run_count: number | null
          runs_with_sacks: number | null
          sacks: number | null
          share_of_month_pct: number | null
          year: number | null
        }
        Relationships: []
      }
      view_analytics_production_monthly: {
        Row: {
          downtime_hrs: number | null
          downtime_shift_count: number | null
          downtime_shifts_reason_only: number | null
          downtime_shifts_with_duration: number | null
          first_reported_date: string | null
          kwh: number | null
          kwh_per_produced_kg: number | null
          kwh_per_produced_kg_excl_suspect: number | null
          kwh_suspect: number | null
          kwh_suspect_reading_count: number | null
          last_reported_date: string | null
          month: number | null
          month_start: string | null
          power_days: number | null
          power_meter_count: number | null
          produced_kg: number | null
          produced_per_reported_day: number | null
          production_reported: boolean | null
          reported_days: number | null
          run_count: number | null
          runs_with_sacks: number | null
          sacks: number | null
          sacks_coverage_pct: number | null
          shift_count: number | null
          year: number | null
        }
        Relationships: []
      }
      view_analytics_rcin_monthly: {
        Row: {
          active_suppliers: number | null
          all_arrivals_kg: number | null
          delivery_count: number | null
          market_avg_price: number | null
          market_delivery_count: number | null
          market_kg: number | null
          market_php_total: number | null
          market_priced_kg: number | null
          month: number | null
          month_start: string | null
          price_coverage_pct: number | null
          recook_delivery_count: number | null
          recook_kg: number | null
          sundry_reentry_delivery_count: number | null
          sundry_reentry_kg: number | null
          year: number | null
        }
        Relationships: []
      }
      view_analytics_supplier_monthly: {
        Row: {
          avg_price_php_kg: number | null
          cumulative_share_pct: number | null
          delivery_count: number | null
          kg: number | null
          kg_rank_in_month: number | null
          month: number | null
          month_avg_price_php_kg: number | null
          month_market_kg: number | null
          month_start: string | null
          php_total: number | null
          premium_php_kg: number | null
          price_coverage_pct: number | null
          priced_kg: number | null
          share_of_month_pct: number | null
          sundry_origin_delivery_count: number | null
          sundry_origin_kg: number | null
          supplier_canonical: string | null
          year: number | null
        }
        Relationships: []
      }
      view_batch_age_days: {
        Row: {
          age_days: number | null
          as_of_date: string | null
          batch_code: string | null
          delivered_kg: number | null
          delivery_count: number | null
          first_delivery_date: string | null
          last_delivery_date: string | null
          mean_daynum: number | null
          mean_delivery_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_digest_rcout_batch_daily"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_campaign_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_blocks_used"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_cells"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_open_blocks"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_code"]
          },
        ]
      }
      view_blend_proposal_list: {
        Row: {
          archived_at: string | null
          block_count: number | null
          created_at: string | null
          created_by: string | null
          created_by_name: string | null
          current_version_change_note: string | null
          current_version_computed_at: string | null
          current_version_created_at: string | null
          current_version_no: number | null
          fed_on: string | null
          id: string | null
          is_archived: boolean | null
          notes: string | null
          row_version: number | null
          status: string | null
          title: string | null
          total_balance_kg: number | null
          updated_at: string | null
          updated_by: string | null
          updated_by_name: string | null
          version_count: number | null
          w_ash: number | null
          w_bd_astm: number | null
          w_mc: number | null
        }
        Relationships: [
          {
            foreignKeyName: "blend_proposals_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_proposals_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      view_blend_proposal_versions: {
        Row: {
          block_count: number | null
          change_note: string | null
          computed_at: string | null
          created_at: string | null
          created_by: string | null
          created_by_name: string | null
          id: string | null
          is_current: boolean | null
          parent_version_no: number | null
          proposal_id: string | null
          snapshot_hash: string | null
          total_balance_kg: number | null
          version_no: number | null
          w_ash: number | null
          w_bd_astm: number | null
          w_bd_jis: number | null
          w_fc: number | null
          w_grit: number | null
          w_mc: number | null
          w_vm: number | null
        }
        Relationships: [
          {
            foreignKeyName: "blend_proposal_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_proposal_versions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "blend_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_proposal_versions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "view_blend_proposal_list"
            referencedColumns: ["id"]
          },
        ]
      }
      view_blocking_block_suppliers: {
        Row: {
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          block_total_in_kg: number | null
          delivery_count: number | null
          kg: number | null
          share_pct: number | null
          supplier_count_in_block: number | null
          supplier_display: string | null
          supplier_key: string | null
        }
        Relationships: []
      }
      view_blocking_grid: {
        Row: {
          avg_ash: number | null
          avg_bd_astm: number | null
          avg_bd_jis: number | null
          avg_fc: number | null
          avg_grit: number | null
          avg_mc: number | null
          avg_php_kg: number | null
          avg_vm: number | null
          balance: number | null
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          status: string | null
          total_in: number | null
        }
        Relationships: []
      }
      view_deliveries_human_edited: {
        Row: {
          batch_code: string | null
          block_loc: string | null
          human_edited_at: string | null
          human_edited_by: string | null
          human_edited_by_name: string | null
          record_id: string | null
          sacks: number | null
          section: string | null
          supplier: string | null
          table_name: string | null
          transaction_date: string | null
          truck_plate: string | null
          weight_kg: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_digest_rcout_batch_daily"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_campaign_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_blocks_used"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_cells"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_open_blocks"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_code"]
          },
        ]
      }
      view_delivery_monthly_analytics: {
        Row: {
          ash: number | null
          avg_price: number | null
          bd_astm: number | null
          bd_jis: number | null
          deliveries: number | null
          fc: number | null
          grit: number | null
          mc: number | null
          month: number | null
          php_total: number | null
          sacks: number | null
          vm: number | null
          volume_kg: number | null
          year: number | null
        }
        Relationships: []
      }
      view_delivery_supplier_monthly_analytics: {
        Row: {
          ash: number | null
          avg_price: number | null
          bd_astm: number | null
          bd_jis: number | null
          deliveries: number | null
          fc: number | null
          grit: number | null
          mc: number | null
          month: number | null
          php_total: number | null
          sacks: number | null
          supplier: string | null
          vm: number | null
          volume_kg: number | null
          year: number | null
        }
        Relationships: []
      }
      view_delivery_supplier_subgroup_yearly_analytics: {
        Row: {
          avg_price: number | null
          deliveries: number | null
          main_supplier: string | null
          php_total: number | null
          sacks: number | null
          subgroup: string | null
          volume_kg: number | null
          year: number | null
        }
        Relationships: []
      }
      view_delivery_supplier_yearly_analytics: {
        Row: {
          ash: number | null
          avg_price: number | null
          bd_astm: number | null
          bd_jis: number | null
          deliveries: number | null
          fc: number | null
          grit: number | null
          mc: number | null
          php_total: number | null
          sacks: number | null
          supplier: string | null
          vm: number | null
          volume_kg: number | null
          year: number | null
        }
        Relationships: []
      }
      view_delivery_yearly_analytics: {
        Row: {
          ash: number | null
          avg_price: number | null
          bd_astm: number | null
          bd_jis: number | null
          deliveries: number | null
          fc: number | null
          grit: number | null
          mc: number | null
          php_total: number | null
          sacks: number | null
          vm: number | null
          volume_kg: number | null
          year: number | null
        }
        Relationships: []
      }
      view_digest_audit_enriched: {
        Row: {
          comment: string | null
          diff: Json | null
          employee: string | null
          id: string | null
          operation: string | null
          performed_at: string | null
          performed_day: string | null
          provenance: string | null
          table_name: string | null
        }
        Insert: {
          comment?: string | null
          diff?: Json | null
          employee?: never
          id?: string | null
          operation?: string | null
          performed_at?: string | null
          performed_day?: never
          provenance?: never
          table_name?: string | null
        }
        Update: {
          comment?: string | null
          diff?: Json | null
          employee?: never
          id?: string | null
          operation?: string | null
          performed_at?: string | null
          performed_day?: never
          provenance?: never
          table_name?: string | null
        }
        Relationships: []
      }
      view_digest_daily_flow: {
        Row: {
          date: string | null
          in_kg: number | null
          out_kg: number | null
        }
        Relationships: []
      }
      view_digest_daily_hours: {
        Row: {
          date: string | null
          downtime_hrs: number | null
          work_hrs: number | null
        }
        Relationships: []
      }
      view_digest_daily_power: {
        Row: {
          date: string | null
          kwh: number | null
        }
        Relationships: []
      }
      view_digest_daily_price: {
        Row: {
          date: string | null
          php_per_kg: number | null
        }
        Relationships: []
      }
      view_digest_daily_production: {
        Row: {
          date: string | null
          kg: number | null
        }
        Relationships: []
      }
      view_digest_grades: {
        Row: {
          date: string | null
          grade: string | null
          kg: number | null
          shift: string | null
        }
        Relationships: []
      }
      view_digest_latest_sync: {
        Row: {
          date: string | null
          delete_count: number | null
          insert_count: number | null
          update_count: number | null
        }
        Relationships: []
      }
      view_digest_latest_sync_by_employee: {
        Row: {
          count: number | null
          date: string | null
          employee: string | null
        }
        Relationships: []
      }
      view_digest_mtd: {
        Row: {
          label: string | null
          month_end: string | null
          month_start: string | null
          production_kg: number | null
          rc_in_kg: number | null
          rc_out_kg: number | null
        }
        Relationships: []
      }
      view_digest_operational_days: {
        Row: {
          operational_date: string | null
          prev_operational_date: string | null
        }
        Relationships: []
      }
      view_digest_power_meter_daily: {
        Row: {
          kwh: number | null
          meter: string | null
          raw_diff_kwh: number | null
          reading_count: number | null
          reading_date: string | null
        }
        Relationships: []
      }
      view_digest_prod_actual_tons: {
        Row: {
          actual_tons: number | null
          date: string | null
        }
        Relationships: []
      }
      view_digest_production_grade_daily: {
        Row: {
          grade: string | null
          kg: number | null
          run_count: number | null
          runs_with_sacks: number | null
          sacks: number | null
          shift_count: number | null
          transaction_date: string | null
        }
        Relationships: []
      }
      view_digest_rcin_daystats: {
        Row: {
          date: string | null
          sacks: number | null
          suppliers: number | null
        }
        Relationships: []
      }
      view_digest_rcin_supplier_daily: {
        Row: {
          delivery_count: number | null
          kg: number | null
          sack_count: number | null
          supplier_canonical: string | null
          transaction_date: string | null
        }
        Relationships: []
      }
      view_digest_rcout_batch_daily: {
        Row: {
          batch_code: string | null
          block_loc: string | null
          destination: string | null
          feeding_count: number | null
          kg: number | null
          transaction_date: string | null
        }
        Relationships: []
      }
      view_digest_stream_freshness: {
        Row: {
          label: string | null
          stream: string | null
          through_date: string | null
        }
        Relationships: []
      }
      view_digest_stream_registry: {
        Row: {
          label: string | null
          reports_next_day: boolean | null
          sort_order: number | null
          stream: string | null
        }
        Relationships: []
      }
      view_digest_stream_reported_days: {
        Row: {
          reported_date: string | null
          stream: string | null
        }
        Relationships: []
      }
      view_digest_stream_status: {
        Row: {
          label: string | null
          missed_working_days: number | null
          operational_date: string | null
          prev_reported_date: string | null
          reports_next_day: boolean | null
          sort_order: number | null
          stream: string | null
          through_date: string | null
        }
        Relationships: []
      }
      view_digest_unpriced_deliveries: {
        Row: {
          batch_code: string | null
          block_loc: string | null
          days_pending: number | null
          id: string | null
          is_overdue: boolean | null
          is_recent: boolean | null
          operational_date: string | null
          sacks: number | null
          supplier: string | null
          transaction_date: string | null
          truck_plate: string | null
          weight_kg: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_digest_rcout_batch_daily"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_campaign_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_blocks_used"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_cells"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_open_blocks"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_code"]
          },
        ]
      }
      view_digest_unpriced_recent: {
        Row: {
          cnt: number | null
        }
        Relationships: []
      }
      view_flecon_bag_balance: {
        Row: {
          bag_type_id: string | null
          balance: number | null
          code: string | null
          label: string | null
          last_movement_date: string | null
          nickname: string | null
          opening: number | null
          sort_order: number | null
          total_in: number | null
          total_out: number | null
        }
        Relationships: []
      }
      view_ops_ledger_campaign_block: {
        Row: {
          actual_fed_php_kg: number | null
          balance_kg: number | null
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          campaign_fed_kg: number | null
          campaign_feed_days: number | null
          campaign_key: string | null
          campaign_sundry_kg: number | null
          campaign_year: number | null
          close_date: string | null
          delivered_kg: number | null
          delivered_php_kg: number | null
          delivery_count: number | null
          feed_count: number | null
          first_campaign_feed_date: string | null
          first_fed_date: string | null
          has_sundry_outflow: boolean | null
          has_unpriced_delivery: boolean | null
          in_price_set: boolean | null
          is_closed: boolean | null
          is_fully_priced: boolean | null
          last_campaign_feed_date: string | null
          loss_pct: number | null
          priced_delivered_php_kg: number | null
          production_batch: string | null
          resiko_kg: number | null
          resiko_pct: number | null
          status: Database["public"]["Enums"]["batch_status"] | null
          sundry_kg: number | null
          total_fed_kg: number | null
          total_out_kg: number | null
          unpriced_delivery_count: number | null
          uplift_php_kg: number | null
          weight_lost_kg: number | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_id"]
          },
        ]
      }
      view_ops_ledger_campaign_grades: {
        Row: {
          campaign_key: string | null
          campaign_label: string | null
          campaign_produced_kg: number | null
          campaign_year: number | null
          grade: string | null
          kg: number | null
          production_batch: string | null
          run_count: number | null
          runs_with_sacks: number | null
          sacks: number | null
          share_pct: number | null
        }
        Relationships: []
      }
      view_ops_ledger_campaign_kpis: {
        Row: {
          active_days: number | null
          actual_fed_php_kg: number | null
          bf_kg: number | null
          block_resiko_kg: number | null
          block_resiko_loss_pct: number | null
          blocks_closed: number | null
          blocks_closed_delivered_kg: number | null
          blocks_closed_resiko_loss_pct: number | null
          blocks_closed_unpriced: number | null
          blocks_delivered_kg: number | null
          blocks_fed: number | null
          blocks_in_price: number | null
          blocks_open: number | null
          blocks_resiko_kg: number | null
          blocks_total_fed_kg: number | null
          blocks_with_sundry: number | null
          campaign_fed_kg_excluded: number | null
          campaign_fed_kg_included: number | null
          campaign_fed_kg_included_pct: number | null
          campaign_key: string | null
          campaign_label: string | null
          campaign_weighted_actual_fed_php_kg: number | null
          campaign_year: number | null
          downtime_hours: number | null
          downtime_shift_count: number | null
          downtime_shifts_reason_only: number | null
          downtime_shifts_with_duration: number | null
          fed_kg: number | null
          fed_kg_price_traceable: number | null
          fed_kg_price_untraceable: number | null
          fed_php_kg: number | null
          fed_price_coverage_pct: number | null
          fed_value_php: number | null
          feed_days: number | null
          first_date: string | null
          first_fed_date: string | null
          grit_kg: number | null
          is_fully_covered: boolean | null
          kwh: number | null
          kwh_days: number | null
          kwh_per_produced_kg: number | null
          kwh_per_produced_kg_excl_suspect: number | null
          kwh_suspect_reading_count: number | null
          last_date: string | null
          last_fed_date: string | null
          ledger_days: number | null
          out_kg: number | null
          php_per_produced_kg_delivered: number | null
          php_per_produced_kg_true: number | null
          process_loss_kg: number | null
          process_loss_pct: number | null
          produced_kg: number | null
          production_batch: string | null
          production_reported: boolean | null
          reported_days: number | null
          rest_days: number | null
          rs1a_kg: number | null
          rs1b_kg: number | null
          rs23_kg: number | null
          rs5_kg: number | null
          run_count: number | null
          runs_with_sacks: number | null
          sacks: number | null
          sacks_coverage_pct: number | null
          shift_count: number | null
          span_days: number | null
          sundry_kg: number | null
          trml1_kg: number | null
          trml2_kg: number | null
          uplift_php_kg: number | null
          waste_kg: number | null
          waste_loss_pct: number | null
          waste_shift_count: number | null
          yield_pct: number | null
        }
        Relationships: []
      }
      view_ops_ledger_campaign_span: {
        Row: {
          campaign_key: string | null
          campaign_label: string | null
          campaign_year: number | null
          feed_days: number | null
          first_date: string | null
          first_fed_date: string | null
          first_shift_date: string | null
          last_date: string | null
          last_fed_date: string | null
          last_shift_date: string | null
          midpoint_date: string | null
          production_batch: string | null
          quarter_key: string | null
          quarter_label: string | null
          quarter_no: number | null
          quarter_year: number | null
          shift_count: number | null
          span_days: number | null
        }
        Relationships: []
      }
      view_ops_ledger_day: {
        Row: {
          bf_kg: number | null
          blocks_fed_count: number | null
          calendar_date: string | null
          campaign_key: string | null
          campaign_label: string | null
          campaign_year: number | null
          day_drift_kg: number | null
          downtime_hours: number | null
          downtime_incident_count: number | null
          downtime_shift_count: number | null
          downtime_shifts_reason_only: number | null
          downtime_shifts_with_duration: number | null
          fed_kg: number | null
          fed_php_kg: number | null
          grit_kg: number | null
          is_rest_day: boolean | null
          is_weekend: boolean | null
          iso_weekday: number | null
          loss_pct: number | null
          produced_kg: number | null
          production_batch: string | null
          production_reported: boolean | null
          rs1a_kg: number | null
          rs1b_kg: number | null
          rs23_kg: number | null
          rs5_kg: number | null
          run_count: number | null
          runs_with_sacks: number | null
          sacks: number | null
          shift_count: number | null
          shift_hrs_total: number | null
          sundry_kg: number | null
          total_waste_kg: number | null
          trml1_kg: number | null
          trml2_kg: number | null
          waste_pct: number | null
          weekday: string | null
          yield_pct: number | null
        }
        Relationships: []
      }
      view_ops_ledger_day_block: {
        Row: {
          ash: number | null
          batch_code: string | null
          batch_id: string | null
          bd_astm: number | null
          bd_jis: number | null
          block_loc: string | null
          calendar_date: string | null
          campaign_key: string | null
          campaign_year: number | null
          fc: number | null
          fed_kg: number | null
          grit: number | null
          mc: number | null
          production_batch: string | null
          sundry_kg: number | null
          vm: number | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_id"]
          },
        ]
      }
      view_ops_ledger_day_blocks_used: {
        Row: {
          balance_kg: number | null
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          calendar_date: string | null
          campaign_key: string | null
          campaign_year: number | null
          close_date: string | null
          day_fed_kg: number | null
          delivered_kg: number | null
          delivery_count: number | null
          feed_count: number | null
          first_fed_date: string | null
          has_sundry_outflow: boolean | null
          has_unpriced_delivery: boolean | null
          is_closed: boolean | null
          loss_pct: number | null
          production_batch: string | null
          resiko_kg: number | null
          resiko_pct: number | null
          status: Database["public"]["Enums"]["batch_status"] | null
          sundry_kg: number | null
          total_fed_kg: number | null
          total_out_kg: number | null
          unpriced_delivery_count: number | null
          weight_lost_kg: number | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_id"]
          },
        ]
      }
      view_ops_ledger_day_fed_blend: {
        Row: {
          ash_kg: number | null
          bd_astm_kg: number | null
          bd_jis_kg: number | null
          blocks_fed_count: number | null
          calendar_date: string | null
          campaign_key: string | null
          campaign_year: number | null
          fc_kg: number | null
          fed_kg: number | null
          grit_kg: number | null
          mc_kg: number | null
          production_batch: string | null
          vm_kg: number | null
          w_ash: number | null
          w_bd_astm: number | null
          w_bd_jis: number | null
          w_fc: number | null
          w_grit: number | null
          w_mc: number | null
          w_vm: number | null
        }
        Relationships: []
      }
      view_ops_ledger_day_grade: {
        Row: {
          calendar_date: string | null
          campaign_key: string | null
          campaign_year: number | null
          grade: string | null
          kg: number | null
          production_batch: string | null
          run_count: number | null
          sacks: number | null
        }
        Relationships: []
      }
      view_ops_ledger_shift: {
        Row: {
          bf_kg: number | null
          calendar_date: string | null
          campaign_key: string | null
          campaign_year: number | null
          downtime_hours: number | null
          downtime_row_present: boolean | null
          dt_hrs: number | null
          dt_incident_ranges: string | null
          dt_mins: number | null
          dt_ranges: string | null
          dt_reason: string | null
          grade_kg: Json | null
          grit_kg: number | null
          has_incident: boolean | null
          produced_kg: number | null
          production_batch: string | null
          productive_hrs: number | null
          rs1a_kg: number | null
          rs1b_kg: number | null
          rs23_kg: number | null
          rs5_kg: number | null
          run_count: number | null
          runs: Json | null
          runs_with_sacks: number | null
          sacks: number | null
          shift: string | null
          shift_hrs: number | null
          shift_hrs_source: string | null
          shift_id: string | null
          total_waste_kg: number | null
          trml1_kg: number | null
          trml2_kg: number | null
          waste_pct: number | null
          waste_remarks: string | null
        }
        Relationships: []
      }
      view_product_ledger: {
        Row: {
          active: boolean | null
          agrees_with_sheet: boolean | null
          ayag_flecs: number | null
          blended_flecs: number | null
          computed_running: Json | null
          date_out_of_sheet_order: boolean | null
          display_name: string | null
          final_flecs: number | null
          flec_delta: number | null
          grade_code: string | null
          grade_id: string | null
          kg_delta: number | null
          magnet_flecs: number | null
          movement_id: string | null
          old_prod_flecs: number | null
          prod_flecs: number | null
          reclass_flecs: number | null
          remarks: string | null
          running_kg: number | null
          sheet_running: Json | null
          source_row: number | null
          stage: string | null
          sundry_flecs: number | null
          total_flecs: number | null
          transaction_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_movements_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "product_grades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_movements_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "view_product_onhand"
            referencedColumns: ["grade_id"]
          },
          {
            foreignKeyName: "product_movements_grade_id_fkey"
            columns: ["grade_id"]
            isOneToOne: false
            referencedRelation: "view_product_stage_balance"
            referencedColumns: ["grade_id"]
          },
        ]
      }
      view_product_onhand: {
        Row: {
          active: boolean | null
          aliases: string[] | null
          ash_max: number | null
          ayag_flecs: number | null
          blended_flecs: number | null
          content_fingerprint: string | null
          date_out_of_order_count: number | null
          display_name: string | null
          final_flecs: number | null
          final_kg: number | null
          final_tons: number | null
          first_movement_date: string | null
          first_seen_at: string | null
          grade_code: string | null
          grade_id: string | null
          kg_per_flec: number | null
          kg_per_flec_as_of: string | null
          kg_per_flec_distinct_count: number | null
          last_movement_date: string | null
          last_seen_at: string | null
          ledger_kg_net: number | null
          magnet_flecs: number | null
          me50_under: number | null
          movement_count: number | null
          movements_missing_kg: number | null
          old_prod_flecs: number | null
          opening_as_of: string | null
          opening_flecs: number | null
          other_flecs: number | null
          prod_flecs: number | null
          reclass_flecs: number | null
          sheet_name: string | null
          sheet_running_disagreement_count: number | null
          shippable_flecs: number | null
          sort_order: number | null
          stage_count: number | null
          sundry_flecs: number | null
          thresholds: Json | null
          total_flecs: number | null
          total_kg: number | null
          total_tons: number | null
          updated_at: string | null
          vans_ready: number | null
          vm_max: number | null
        }
        Relationships: []
      }
      view_product_portfolio: {
        Row: {
          active_grade_count: number | null
          final_flecs: number | null
          final_kg: number | null
          final_tons: number | null
          grade_count: number | null
          grades_without_rate: number | null
          last_movement_date: string | null
          movement_count: number | null
          total_flecs: number | null
          total_kg: number | null
          total_tons: number | null
          vans_ready: number | null
        }
        Relationships: []
      }
      view_product_stage_balance: {
        Row: {
          active: boolean | null
          balance_flecs: number | null
          display_name: string | null
          first_movement_date: string | null
          grade_code: string | null
          grade_id: string | null
          last_movement_date: string | null
          movement_count: number | null
          movement_flecs: number | null
          movement_kg: number | null
          movements_missing_kg: number | null
          opening_as_of: string | null
          opening_flecs: number | null
          sheet_name: string | null
          sort_order: number | null
          stage: string | null
        }
        Relationships: []
      }
      view_production_daily: {
        Row: {
          bf_kg: number | null
          dt_hrs: number | null
          dt_mins: number | null
          dt_reason: string | null
          dt_total_hrs: number | null
          grit_kg: number | null
          kg_2x6: number | null
          kg_3x50: number | null
          kg_6x50: number | null
          kg_8x50: number | null
          prod_loss_pct: number | null
          production_batch: string | null
          productive_hrs: number | null
          rs1a_kg: number | null
          rs1b_kg: number | null
          rs23_kg: number | null
          rs5_kg: number | null
          shift: string | null
          shift_hrs: number | null
          shift_id: string | null
          total_output_kg: number | null
          total_waste_kg: number | null
          transaction_date: string | null
          trml1_kg: number | null
          trml2_kg: number | null
          waste_remarks: string | null
        }
        Relationships: []
      }
      view_production_human_edited: {
        Row: {
          human_edited_at: string | null
          human_edited_by: string | null
          human_edited_by_name: string | null
          meter: string | null
          plate_no: string | null
          production_batch: string | null
          record_id: string | null
          section: string | null
          shift: string | null
          table_name: string | null
          transaction_date: string | null
        }
        Relationships: []
      }
      view_rc_in_master: {
        Row: {
          batch_code: string | null
          block_loc: string | null
          cost_basis: number | null
          created_at: string | null
          id: string | null
          lab_results: Json | null
          remarks: string | null
          sacks: number | null
          state: Database["public"]["Enums"]["batch_status"] | null
          supplier: string | null
          transaction_date: string | null
          truck_plate: string | null
          weight_kg: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_digest_rcout_batch_daily"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_campaign_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_blocks_used"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_cells"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_open_blocks"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_code"]
          },
        ]
      }
      view_rc_movement: {
        Row: {
          balance_after: number | null
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          closed_today: boolean | null
          cum_fed: number | null
          cum_out: number | null
          date: string | null
          deliveries_total: number | null
          fed_today: number | null
          feed_day_n: number | null
          out_today: number | null
          pct_loss: number | null
          php_per_kg: number | null
          php_total: number | null
          start_balance: number | null
          status: string | null
          sundry_today: number | null
          supplier: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_id"]
          },
        ]
      }
      view_rc_movement_batch_price: {
        Row: {
          batch_code: string | null
          batch_id: string | null
          batch_price: number | null
        }
        Relationships: []
      }
      view_rc_movement_block_actual_price: {
        Row: {
          actual_fed_php_kg: number | null
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          close_date: string | null
          delivered_kg: number | null
          delivered_php_kg: number | null
          delivered_value_php: number | null
          delivery_count: number | null
          feed_count: number | null
          first_fed_date: string | null
          first_main_fed_date: string | null
          has_sundry_outflow: boolean | null
          has_unpriced_delivery: boolean | null
          is_closed: boolean | null
          is_fully_priced: boolean | null
          last_fed_date: string | null
          last_main_fed_date: string | null
          loss_pct: number | null
          main_feed_count: number | null
          out_php_kg: number | null
          priced_delivered_kg: number | null
          priced_delivered_php_kg: number | null
          priced_delivery_count: number | null
          status: Database["public"]["Enums"]["batch_status"] | null
          sundry_kg: number | null
          total_fed_kg: number | null
          total_out_kg: number | null
          unpriced_delivered_kg: number | null
          unpriced_delivery_count: number | null
          uplift_pct: number | null
          uplift_php_kg: number | null
          weight_lost_kg: number | null
        }
        Relationships: []
      }
      view_rc_movement_campaign_actual_price: {
        Row: {
          actual_fed_php_kg: number | null
          block_fed_kg: number | null
          blocks_closed: number | null
          blocks_closed_unpriced: number | null
          blocks_fed: number | null
          blocks_in_price: number | null
          blocks_open: number | null
          blocks_sundry_kg: number | null
          blocks_with_sundry: number | null
          campaign_fed_kg: number | null
          campaign_fed_kg_closed: number | null
          campaign_fed_kg_excluded: number | null
          campaign_fed_kg_included: number | null
          campaign_fed_kg_included_pct: number | null
          campaign_fed_kg_open: number | null
          campaign_weighted_actual_fed_php_kg: number | null
          campaign_year: number | null
          delivered_kg: number | null
          delivered_php_kg: number | null
          delivered_value_php: number | null
          is_fully_covered: boolean | null
          loss_pct: number | null
          production_batch: string | null
          uplift_php_kg: number | null
          weight_lost_kg: number | null
        }
        Relationships: []
      }
      view_rc_movement_campaign_cells: {
        Row: {
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          campaign_year: number | null
          date: string | null
          fed_kg: number | null
          production_batch: string | null
          sundry_kg: number | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_id"]
          },
        ]
      }
      view_rc_movement_campaign_day_price: {
        Row: {
          campaign_year: number | null
          date: string | null
          production_batch: string | null
          total_fed: number | null
          wtd_fed_price: number | null
        }
        Relationships: []
      }
      view_rc_movement_campaign_open_blocks: {
        Row: {
          balance_kg: number | null
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          campaign_fed_kg: number | null
          campaign_fed_kg_total: number | null
          campaign_fed_share: number | null
          campaign_feed_days: number | null
          campaign_first_fed_date: string | null
          campaign_last_fed_date: string | null
          campaign_year: number | null
          delivered_kg: number | null
          delivered_php_kg: number | null
          delivered_value_php: number | null
          fed_kg_to_date: number | null
          fed_share_of_delivered: number | null
          feed_count: number | null
          first_fed_date: string | null
          has_sundry_outflow: boolean | null
          has_unpriced_delivery: boolean | null
          last_fed_date: string | null
          out_kg_to_date: number | null
          priced_delivered_php_kg: number | null
          production_batch: string | null
          status: Database["public"]["Enums"]["batch_status"] | null
          sundry_kg: number | null
          unpriced_delivery_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "usage_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_id"]
          },
        ]
      }
      view_rc_movement_campaign_options: {
        Row: {
          campaign_year: number | null
          feed_days: number | null
          max_date: string | null
          min_date: string | null
          out_days: number | null
          out_kg: number | null
          production_batch: string | null
          sundry_kg: number | null
          total_fed: number | null
        }
        Relationships: []
      }
      view_rc_movement_campaign_price: {
        Row: {
          campaign_year: number | null
          production_batch: string | null
          total_fed: number | null
          wtd_fed_price: number | null
        }
        Relationships: []
      }
      view_rc_movement_campaign_production: {
        Row: {
          campaign_year: number | null
          grade: string | null
          produced_kg: number | null
          production_batch: string | null
        }
        Relationships: []
      }
      view_rc_movement_campaign_production_daily: {
        Row: {
          campaign_year: number | null
          date: string | null
          grade: string | null
          produced_kg: number | null
          production_batch: string | null
        }
        Relationships: []
      }
      view_rc_movement_campaign_production_daily_total: {
        Row: {
          campaign_year: number | null
          date: string | null
          produced_kg: number | null
          production_batch: string | null
        }
        Relationships: []
      }
      view_rc_movement_campaign_yield: {
        Row: {
          campaign_year: number | null
          loss_kg: number | null
          production_batch: string | null
          total_fed: number | null
          total_produced: number | null
          yield_pct: number | null
        }
        Relationships: []
      }
      view_rc_movement_day_price: {
        Row: {
          date: string | null
          total_fed: number | null
          wtd_fed_price: number | null
        }
        Relationships: []
      }
      view_rc_movement_month_price: {
        Row: {
          month_start: string | null
          total_fed: number | null
          wtd_fed_price: number | null
        }
        Relationships: []
      }
      view_rc_movement_production_daily: {
        Row: {
          date: string | null
          grade: string | null
          produced_kg: number | null
        }
        Relationships: []
      }
      view_rc_movement_production_daily_total: {
        Row: {
          date: string | null
          produced_kg: number | null
        }
        Relationships: []
      }
      view_rc_movement_production_monthly: {
        Row: {
          grade: string | null
          month_start: string | null
          produced_kg: number | null
        }
        Relationships: []
      }
      view_rc_movement_yield_monthly: {
        Row: {
          loss_kg: number | null
          month_start: string | null
          total_fed: number | null
          total_produced: number | null
          yield_pct: number | null
        }
        Relationships: []
      }
      view_rc_out_closed_blocks: {
        Row: {
          avg_price: number | null
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          close_date: string | null
          feed_count: number | null
          first_fed_date: string | null
          sundry_kg: number | null
          total_fed_kg: number | null
          total_out_kg: number | null
          total_value: number | null
        }
        Relationships: []
      }
      view_supplier_deliveries: {
        Row: {
          batch_code: string | null
          block_loc: string | null
          cost_basis: number | null
          created_at: string | null
          id: string | null
          lab_results: Json | null
          remarks: string | null
          sacks: number | null
          supplier: string | null
          transaction_date: string | null
          truck_plate: string | null
          weight_kg: number | null
        }
        Insert: {
          batch_code?: string | null
          block_loc?: string | null
          cost_basis?: number | null
          created_at?: string | null
          id?: string | null
          lab_results?: Json | null
          remarks?: string | null
          sacks?: number | null
          supplier?: string | null
          transaction_date?: string | null
          truck_plate?: string | null
          weight_kg?: number | null
        }
        Update: {
          batch_code?: string | null
          block_loc?: string | null
          cost_basis?: number | null
          created_at?: string | null
          id?: string | null
          lab_results?: Json | null
          remarks?: string | null
          sacks?: number | null
          supplier?: string | null
          transaction_date?: string | null
          truck_plate?: string | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_analytics_aging_watchlist"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_block_suppliers"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_blocking_grid"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_digest_rcout_batch_daily"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_campaign_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_block"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_ops_ledger_day_blocks_used"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_batch_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_block_actual_price"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_cells"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_movement_campaign_open_blocks"
            referencedColumns: ["batch_code"]
          },
          {
            foreignKeyName: "fk_batch_code"
            columns: ["batch_code"]
            isOneToOne: false
            referencedRelation: "view_rc_out_closed_blocks"
            referencedColumns: ["batch_code"]
          },
        ]
      }
      view_sync_finding_acks_current: {
        Row: {
          acked_at: string | null
          acked_by: string | null
          action: string | null
          content_hash: string | null
          fingerprint: string | null
          id: string | null
          kind: string | null
          note: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_finding_acks_acked_by_fkey"
            columns: ["acked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      view_sync_run_reports: {
        Row: {
          bytes: number | null
          contains_prices: boolean | null
          dry_run: boolean | null
          duration_seconds: number | null
          error: string | null
          error_count: number | null
          filename: string | null
          finding_count: number | null
          finished_at: string | null
          generated_at: string | null
          generator_version: string | null
          is_latest: boolean | null
          ok: boolean | null
          report_id: string | null
          requested_by: string | null
          run_id: string | null
          run_status: Database["public"]["Enums"]["sync_run_status"] | null
          sheet_counts: Json | null
          started_at: string | null
          storage_bucket: string | null
          storage_path: string | null
          warn_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_run_reports_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      view_trucks_monthly: {
        Row: {
          month: string | null
          month_end_km: number | null
          month_fuel_liters: number | null
          month_km: number | null
          month_start_km: number | null
          plate_no: string | null
          reading_count: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      _insert_notification: {
        Args: {
          p_body: string
          p_metadata: Json
          p_source_user_id?: string
          p_title: string
          p_type: Database["public"]["Enums"]["notification_type"]
          p_user_id: string
        }
        Returns: undefined
      }
      canonical_supplier: { Args: { p_supplier: string }; Returns: string }
      cenapro_add_grade: {
        Args: { p_code: string; p_display_name?: string; p_sort_order?: number }
        Returns: Json
      }
      cenapro_add_partner_draw: {
        Args: {
          p_allow_duplicate?: boolean
          p_batch?: string
          p_batch_year?: number
          p_flec_count?: number
          p_grade_code: string
          p_notes?: string
          p_partner_equipment_code: string
          p_plant?: string
          p_prod_date?: string
          p_recv_date: string
          p_shift_code: string
          p_source_location_code: string
          p_warehouse_code?: string
          p_weight_kg: number
          p_whse_side?: string
        }
        Returns: Json
      }
      cenapro_allocate_delivery_to_payment: {
        Args: {
          p_amount_php?: number
          p_delivery_id?: string
          p_expected_row_version?: number
          p_note?: string
          p_payment_id: string
        }
        Returns: Json
      }
      cenapro_delete_rc_delivery: {
        Args: {
          p_expected_row_version: number
          p_id: string
          p_release_allocations?: boolean
        }
        Returns: Json
      }
      cenapro_delete_rc_payment: {
        Args: { p_expected_row_version: number; p_id: string }
        Returns: Json
      }
      cenapro_flec_balance: {
        Args: { p_start_date: string; p_warehouse_code: string }
        Returns: {
          as_of: string
          current_flec: number
          grade_code: string
          opening_seed: number
          side: string
          warehouse_code: string
        }[]
      }
      cenapro_flec_ledger: {
        Args: { p_start_date: string; p_warehouse_code: string }
        Returns: {
          disposition_kind: string
          flec_in: number
          flec_in_to_date: number
          flec_out: number
          flec_out_to_date: number
          grade_code: string
          id: string
          kg_moved: number
          opening_seed: number
          partner_equipment_code: string
          prod_date: string
          recv_date: string
          running_balance: number
          side: string
          source_location_code: string
          warehouse_code: string
        }[]
      }
      cenapro_import_analysis_samples: { Args: { p_rows: Json }; Returns: Json }
      cenapro_opening_balance_history: {
        Args: { p_warehouse_code: string }
        Returns: {
          created_at: string
          grade_code: string
          id: string
          opening_flec_count: number
          period_start_date: string
          side: string
          warehouse_code: string
        }[]
      }
      cenapro_opening_balances: {
        Args: { p_as_of_date: string; p_warehouse_code: string }
        Returns: {
          created_at: string
          grade_code: string
          opening_flec_count: number
          period_start_date: string
          side: string
          warehouse_code: string
        }[]
      }
      cenapro_restore_rc_payment: {
        Args: { p_expected_row_version: number; p_id: string }
        Returns: Json
      }
      cenapro_restore_rc_payment_allocation: {
        Args: { p_expected_row_version: number; p_id: string }
        Returns: Json
      }
      cenapro_save_analysis_sample: {
        Args: {
          p_ash?: number
          p_bd?: number
          p_expected_row_version?: number
          p_grit?: number
          p_mc?: number
          p_notes?: string
          p_sample_date: string
          p_source_location_code: string
          p_whse_key: string
        }
        Returns: Json
      }
      cenapro_save_rc_bank: {
        Args: {
          p_code: string
          p_expected_row_version?: number
          p_patch?: Json
        }
        Returns: Json
      }
      cenapro_save_rc_bank_account: {
        Args: { p_expected_row_version?: number; p_id?: string; p_patch?: Json }
        Returns: Json
      }
      cenapro_save_rc_delivery: {
        Args: { p_expected_row_version?: number; p_id?: string; p_patch?: Json }
        Returns: Json
      }
      cenapro_save_rc_delivery_samples: {
        Args: {
          p_delivery_id: string
          p_expected_row_version: number
          p_samples?: Json
        }
        Returns: Json
      }
      cenapro_save_rc_payment: {
        Args: { p_expected_row_version?: number; p_id?: string; p_patch?: Json }
        Returns: Json
      }
      cenapro_save_rc_payment_allocations: {
        Args: {
          p_allocations?: Json
          p_expected_row_version?: number
          p_payment_id: string
        }
        Returns: Json
      }
      cenapro_save_rc_supplier: {
        Args: {
          p_code: string
          p_expected_row_version?: number
          p_patch?: Json
        }
        Returns: Json
      }
      cenapro_set_opening_balance: {
        Args: {
          p_count: number
          p_effective_date: string
          p_grade_code: string
          p_side: string
          p_warehouse_code: string
        }
        Returns: {
          created_at: string
          grade_code: string
          id: string
          opening_flec_count: number
          period_start_date: string
          side: string
          warehouse_code: string
        }[]
      }
      cenapro_set_rc_supplier_opening_balance: {
        Args: {
          p_as_of_date: string
          p_note?: string
          p_opening_balance_php: number
          p_supplier_code: string
        }
        Returns: Json
      }
      cenapro_update_event_weight: {
        Args: {
          p_event_id: string
          p_expected_weight_kg: number
          p_weight_kg: number
        }
        Returns: Json
      }
      fn_apply_delivery_upstream: { Args: { p_ops?: Json }; Returns: Json }
      fn_apply_production_upstream: { Args: { p_ops?: Json }; Returns: Json }
      fn_archive_and_delete_delivery: {
        Args: {
          p_archive_batch_id?: string
          p_delivery_id: string
          p_reason: string
        }
        Returns: string
      }
      fn_archive_blend_proposal: {
        Args: { p_expected_row_version?: number; p_id: string }
        Returns: Json
      }
      fn_archive_delivery: {
        Args: {
          p_archive_batch_id?: string
          p_delivery_id: string
          p_reason: string
        }
        Returns: string
      }
      fn_audit_trigger_function_grants: {
        Args: { p_role?: unknown }
        Returns: {
          callee_is_secdef: boolean
          hops: number
          on_table: string
          trigger_function: string
          trigger_name: string
          unexecutable_callee: string
        }[]
      }
      fn_blend_analysis: {
        Args: {
          p_age_edge_days?: number[]
          p_block_locs?: string[]
          p_market_php_kg?: number
          p_price_edge_offsets?: number[]
          p_proposal_id?: string
          p_rounded_up_php?: number
          p_version_no?: number
        }
        Returns: Json
      }
      fn_blend_analysis_probe: {
        Args: { p_proposal_id: string; p_version_no: number }
        Returns: Json
      }
      fn_blend_block_facts: {
        Args: { p_as_of?: string; p_batch_ids: string[] }
        Returns: {
          as_of: string
          batch_code: string
          batch_id: string
          days_since_last_piled: number
          days_since_opened: number
          delivery_count: number
          dominant_share_pct: number
          dominant_supplier_display: string
          dominant_supplier_key: string
          first_delivery_date: string
          is_single_supplier: boolean
          last_delivery_date: string
          supplier_count: number
          suppliers: Json
        }[]
      }
      fn_blend_block_facts_probe: { Args: never; Returns: Json }
      fn_blend_production_loss_pct: { Args: never; Returns: number }
      fn_blend_proposal: {
        Args: { p_block_locs: string[] }
        Returns: {
          block_count: number
          raw_price_per_kg: number
          total_balance: number
          w_ash: number
          w_bd_astm: number
          w_bd_jis: number
          w_fc: number
          w_grit: number
          w_mc: number
          w_vm: number
        }[]
      }
      fn_blend_proposal_snapshot: {
        Args: { p_block_locs: string[] }
        Returns: Json
      }
      fn_blend_snapshot_hash: { Args: { p_snapshot: Json }; Returns: string }
      fn_blocking_age_lens: { Args: { p_edge_days?: number[] }; Returns: Json }
      fn_blocking_age_lens_probe: { Args: never; Returns: Json }
      fn_blocking_market_bases: {
        Args: { p_trailing_days?: number }
        Returns: {
          basis_key: string
          delivery_count: number
          from_date: string
          market_php_kg: number
          priced_kg: number
          to_date: string
        }[]
      }
      fn_blocking_price_lens: {
        Args: {
          p_edge_offsets?: number[]
          p_market_php_kg: number
          p_rounded_up_php?: number
        }
        Returns: Json
      }
      fn_blocking_price_lens_probe: {
        Args: { p_trailing_days?: number }
        Returns: Json
      }
      fn_bulk_update_deliveries: { Args: { rows: Json }; Returns: undefined }
      fn_bulk_update_usage: { Args: { rows: Json }; Returns: undefined }
      fn_close_batch: { Args: { p_batch_id: string }; Returns: boolean }
      fn_delivery_class: {
        Args: { p_batch_code: string; p_remarks?: string; p_supplier?: string }
        Returns: string
      }
      fn_flecon_replace_date: {
        Args: { p_date: string; p_rows?: Json }
        Returns: Json
      }
      fn_is_close_remark: { Args: { p_remarks: string }; Returns: boolean }
      fn_natural_breaks_3: {
        Args: { p_values: number[]; p_weights?: number[] }
        Returns: Json
      }
      fn_ops_ledger_group_blocks: {
        Args: { p_campaign_keys: string[] }
        Returns: {
          actual_fed_php_kg: number
          balance_kg: number
          batch_code: string
          batch_id: string
          block_loc: string
          campaign_count: number
          campaign_keys: string[]
          close_date: string
          delivered_kg: number
          delivered_php_kg: number
          delivery_count: number
          feed_count: number
          first_fed_date: string
          first_group_feed_date: string
          group_fed_kg: number
          group_feed_days: number
          group_sundry_kg: number
          has_sundry_outflow: boolean
          has_unpriced_delivery: boolean
          in_price_set: boolean
          is_closed: boolean
          is_fully_priced: boolean
          last_group_feed_date: string
          loss_pct: number
          priced_delivered_php_kg: number
          resiko_kg: number
          resiko_pct: number
          status: Database["public"]["Enums"]["batch_status"]
          sundry_kg: number
          total_fed_kg: number
          total_out_kg: number
          unpriced_delivery_count: number
          uplift_php_kg: number
          weight_lost_kg: number
        }[]
      }
      fn_ops_ledger_group_kpis: {
        Args: { p_campaign_keys: string[] }
        Returns: {
          active_days: number
          actual_fed_php_kg: number
          bf_kg: number
          block_resiko_loss_pct: number
          blocks_closed_distinct: number
          blocks_fed_campaign_sum: number
          blocks_fed_distinct: number
          blocks_open_distinct: number
          campaign_count: number
          campaign_fed_kg_included: number
          campaign_keys: string[]
          campaigns_fully_covered: number
          campaigns_missing: string[]
          campaigns_production_reported: number
          campaigns_waste_reported: number
          covered_fed_kg_share: number
          downtime_hours: number
          fed_kg: number
          fed_kg_production_reported: number
          fed_php_kg: number
          fed_price_coverage_pct: number
          fed_value_php: number
          first_date: string
          grit_kg: number
          is_fully_covered: boolean
          last_date: string
          ledger_days: number
          php_per_produced_kg_delivered: number
          php_per_produced_kg_true: number
          php_per_produced_kg_true_covered: number
          process_loss_kg: number
          process_loss_pct: number
          produced_kg: number
          produced_kg_waste_reported: number
          reported_calendar_days: number
          reported_campaign_days: number
          rest_days: number
          rs1a_kg: number
          rs1b_kg: number
          rs23_kg: number
          rs5_kg: number
          run_count: number
          sacks: number
          shift_count: number
          sundry_kg: number
          trml1_kg: number
          trml2_kg: number
          uplift_php_kg: number
          waste_kg: number
          waste_loss_pct: number
          waste_shift_count: number
          yield_pct: number
        }[]
      }
      fn_ops_ledger_verify_campaign: {
        Args: { p_campaign_key: string }
        Returns: Json
      }
      fn_ops_ledger_verify_group: {
        Args: { p_campaign_keys: string[] }
        Returns: Json
      }
      fn_ops_ledger_verify_posture: { Args: never; Returns: Json }
      fn_product_grade_fingerprint: {
        Args: { p_payload: Json }
        Returns: string
      }
      fn_recompute_batch_state: {
        Args: { p_batch_code: string }
        Returns: undefined
      }
      fn_record_delivery_source_alias: {
        Args: {
          p_evidence: string
          p_kind: string
          p_ours: string
          p_ours_raw?: string
          p_seen_on?: string
          p_theirs: string
          p_theirs_raw?: string
        }
        Returns: string
      }
      fn_release_delivery_rows: { Args: { p_ids: string[] }; Returns: Json }
      fn_release_production_rows: {
        Args: { p_ids: string[]; p_table: string }
        Returns: Json
      }
      fn_rename_product_grade: {
        Args: { p_grade_id: string; p_new_sheet_name: string }
        Returns: Json
      }
      fn_replace_product_grade: {
        Args: { p_grade_id: string; p_movements?: Json; p_openings?: Json }
        Returns: Json
      }
      fn_restore_archive_batch: {
        Args: { p_archive_batch_id: string }
        Returns: Json
      }
      fn_restore_archived_delivery: {
        Args: { p_archive_id: string }
        Returns: Json
      }
      fn_restore_blend_proposal: {
        Args: { p_expected_row_version?: number; p_id: string }
        Returns: Json
      }
      fn_save_blend_proposal: {
        Args: {
          p_block_locs: string[]
          p_change_note?: string
          p_expected_version_no?: number
          p_notes?: string
          p_proposal_id?: string
          p_title: string
        }
        Returns: Json
      }
      fn_update_blend_proposal_header: {
        Args: { p_expected_row_version: number; p_id: string; p_patch?: Json }
        Returns: Json
      }
      fn_upsert_product_grade: {
        Args: {
          p_fingerprint?: string
          p_opening_as_of?: string
          p_sheet_name: string
          p_thresholds?: Json
        }
        Returns: Json
      }
      is_admin: { Args: { user_id: string }; Returns: boolean }
      rc_out_avg_price: {
        Args: { rc_out_row: Database["public"]["Tables"]["rc_out"]["Row"] }
        Returns: number
      }
      rc_out_avg_wtd_value: {
        Args: { rc_out_row: Database["public"]["Tables"]["rc_out"]["Row"] }
        Returns: number
      }
      set_audit_comment: { Args: { comment: string }; Returns: undefined }
      stamp_ingestion_audit: {
        Args: {
          p_comment: string
          p_operation: string
          p_record_id: string
          p_snapshot?: Json
          p_table_name: string
        }
        Returns: number
      }
      write_ingestion_audit: {
        Args: {
          p_comment?: string
          p_diff?: Json
          p_operation: string
          p_record_id: string
          p_snapshot?: Json
          p_table_name: string
        }
        Returns: string
      }
    }
    Enums: {
      batch_status:
        | "STORED"
        | "IN-USE"
        | "CLOSED"
        | "FEED"
        | "SUNDRYING"
        | "SUNDRIED"
      notification_type:
        | "resolve_request"
        | "resolve_approved"
        | "resolve_denied"
        | "delivery_created"
        | "delivery_edited"
        | "delivery_deleted"
        | "remarks_added"
        | "audit_comment_reply"
      sync_run_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "partial"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      batch_status: [
        "STORED",
        "IN-USE",
        "CLOSED",
        "FEED",
        "SUNDRYING",
        "SUNDRIED",
      ],
      notification_type: [
        "resolve_request",
        "resolve_approved",
        "resolve_denied",
        "delivery_created",
        "delivery_edited",
        "delivery_deleted",
        "remarks_added",
        "audit_comment_reply",
      ],
      sync_run_status: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "partial",
        "cancelled",
      ],
    },
  },
} as const
