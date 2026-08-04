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
    PostgrestVersion: "14.1"
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
      deliveries: {
        Row: {
          batch_code: string | null
          block_loc: string | null
          cost_basis: number
          created_at: string | null
          deduction_note: string | null
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
            referencedRelation: "view_blocking_grid"
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
            referencedRelation: "view_rc_movement_campaign_cells"
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
      production_downtime: {
        Row: {
          created_at: string
          dt_hrs: number
          dt_mins: number
          dt_reason: string | null
          human_edited_at: string | null
          human_edited_by: string | null
          id: string
          shift_hrs: number
          shift_id: string
        }
        Insert: {
          created_at?: string
          dt_hrs?: number
          dt_mins?: number
          dt_reason?: string | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          shift_hrs: number
          shift_id: string
        }
        Update: {
          created_at?: string
          dt_hrs?: number
          dt_mins?: number
          dt_reason?: string | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          id?: string
          shift_hrs?: number
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
            referencedRelation: "view_production_daily"
            referencedColumns: ["shift_id"]
          },
        ]
      }
      production_schedule: {
        Row: {
          dow: string | null
          grades: Json | null
          human_edited_at: string | null
          human_edited_by: string | null
          month: number
          owner: string
          pending_upstream: Json | null
          plan_date: string
          projected_tons: number | null
          remarks: string | null
          row_version: number
          setup: string | null
          shifts: number
          source: string
          source_rev: string | null
          updated_at: string
          year: number
        }
        Insert: {
          dow?: string | null
          grades?: Json | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          month: number
          owner?: string
          pending_upstream?: Json | null
          plan_date: string
          projected_tons?: number | null
          remarks?: string | null
          row_version?: number
          setup?: string | null
          shifts?: number
          source?: string
          source_rev?: string | null
          updated_at?: string
          year: number
        }
        Update: {
          dow?: string | null
          grades?: Json | null
          human_edited_at?: string | null
          human_edited_by?: string | null
          month?: number
          owner?: string
          pending_upstream?: Json | null
          plan_date?: string
          projected_tons?: number | null
          remarks?: string | null
          row_version?: number
          setup?: string | null
          shifts?: number
          source?: string
          source_rev?: string | null
          updated_at?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "production_schedule_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          dust: number | null
          fc: number | null
          grit: number | null
          gross_weight_kg: number | null
          has_import_flags: boolean | null
          id: string | null
          import_flag_count: number | null
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
      view_digest_prod_actual_tons: {
        Row: {
          actual_tons: number | null
          date: string | null
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
      view_production_schedule_conflicts: {
        Row: {
          changed_fields: Json | null
          current_values: Json | null
          human_edited_at: string | null
          human_edited_by: string | null
          observed_at: string | null
          owner: string | null
          pending_source_rev: string | null
          plan_date: string | null
          proposed: Json | null
          row_version: number | null
          updated_at: string | null
        }
        Insert: {
          changed_fields?: never
          current_values?: never
          human_edited_at?: string | null
          human_edited_by?: string | null
          observed_at?: never
          owner?: string | null
          pending_source_rev?: never
          plan_date?: string | null
          proposed?: never
          row_version?: number | null
          updated_at?: string | null
        }
        Update: {
          changed_fields?: never
          current_values?: never
          human_edited_at?: string | null
          human_edited_by?: string | null
          observed_at?: never
          owner?: string | null
          pending_source_rev?: never
          plan_date?: string | null
          proposed?: never
          row_version?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "production_schedule_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      view_production_schedule_state: {
        Row: {
          dow: string | null
          effective_owner: string | null
          grades: Json | null
          has_pending_upstream: boolean | null
          human_edit_after_report: boolean | null
          human_edited_at: string | null
          human_edited_by: string | null
          is_reported: boolean | null
          month: number | null
          owner: string | null
          pending_source_rev: string | null
          pending_upstream: Json | null
          plan_date: string | null
          projected_tons: number | null
          remarks: string | null
          row_version: number | null
          setup: string | null
          shifts: number | null
          source: string | null
          source_rev: string | null
          updated_at: string | null
          year: number | null
        }
        Insert: {
          dow?: string | null
          effective_owner?: never
          grades?: Json | null
          has_pending_upstream?: never
          human_edit_after_report?: never
          human_edited_at?: string | null
          human_edited_by?: string | null
          is_reported?: never
          month?: number | null
          owner?: string | null
          pending_source_rev?: never
          pending_upstream?: Json | null
          plan_date?: string | null
          projected_tons?: number | null
          remarks?: string | null
          row_version?: number | null
          setup?: string | null
          shifts?: number | null
          source?: string | null
          source_rev?: string | null
          updated_at?: string | null
          year?: number | null
        }
        Update: {
          dow?: string | null
          effective_owner?: never
          grades?: Json | null
          has_pending_upstream?: never
          human_edit_after_report?: never
          human_edited_at?: string | null
          human_edited_by?: string | null
          is_reported?: never
          month?: number | null
          owner?: string | null
          pending_source_rev?: never
          pending_upstream?: Json | null
          plan_date?: string | null
          projected_tons?: number | null
          remarks?: string | null
          row_version?: number | null
          setup?: string | null
          shifts?: number | null
          source?: string | null
          source_rev?: string | null
          updated_at?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "production_schedule_human_edited_by_fkey"
            columns: ["human_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "view_blocking_grid"
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
            referencedRelation: "view_rc_movement_campaign_cells"
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
          date: string | null
          deliveries_total: number | null
          fed_today: number | null
          feed_day_n: number | null
          pct_loss: number | null
          php_per_kg: number | null
          php_total: number | null
          start_balance: number | null
          status: string | null
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
      view_rc_movement_campaign_cells: {
        Row: {
          batch_code: string | null
          batch_id: string | null
          block_loc: string | null
          campaign_year: number | null
          date: string | null
          fed_kg: number | null
          production_batch: string | null
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
      view_rc_movement_campaign_options: {
        Row: {
          campaign_year: number | null
          feed_days: number | null
          max_date: string | null
          min_date: string | null
          production_batch: string | null
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
          total_fed_kg: number | null
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
            referencedRelation: "view_blocking_grid"
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
            referencedRelation: "view_rc_movement_campaign_cells"
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
      cenapro_add_partner_draw: {
        Args: {
          p_allow_duplicate?: boolean
          p_batch?: string
          p_batch_year?: number
          p_flec_count?: number
          p_grade_code: string
          p_notes?: string
          p_partner_equipment_code: string
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
      cenapro_delete_rc_delivery: {
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
      cenapro_update_event_weight: {
        Args: {
          p_event_id: string
          p_expected_weight_kg: number
          p_weight_kg: number
        }
        Returns: Json
      }
      fn_apply_production_upstream: { Args: { p_ops?: Json }; Returns: Json }
      fn_apply_schedule_upstream: { Args: { p_ops?: Json }; Returns: Json }
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
      fn_bulk_update_deliveries: { Args: { rows: Json }; Returns: undefined }
      fn_bulk_update_usage: { Args: { rows: Json }; Returns: undefined }
      fn_close_batch: { Args: { p_batch_id: string }; Returns: boolean }
      fn_flecon_replace_date: {
        Args: { p_date: string; p_rows?: Json }
        Returns: Json
      }
      fn_is_close_remark: { Args: { p_remarks: string }; Returns: boolean }
      fn_recompute_batch_state: {
        Args: { p_batch_code: string }
        Returns: undefined
      }
      fn_release_production_rows: {
        Args: { p_ids: string[]; p_table: string }
        Returns: Json
      }
      fn_release_schedule_day: {
        Args: { p_expected_row_version: number; p_plan_date: string }
        Returns: Json
      }
      fn_save_schedule_day: {
        Args: {
          p_clear_pending?: boolean
          p_expected_row_version: number
          p_patch?: Json
          p_plan_date: string
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
