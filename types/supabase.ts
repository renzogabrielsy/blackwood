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
          id: string
          lab_results: Json
          remarks: string | null
          sacks: number | null
          supplier: string
          transaction_date: string
          truck_plate: string | null
          weight_kg: number
        }
        Insert: {
          batch_code?: string | null
          block_loc?: string | null
          cost_basis: number
          created_at?: string | null
          id?: string
          lab_results?: Json
          remarks?: string | null
          sacks?: number | null
          supplier: string
          transaction_date: string
          truck_plate?: string | null
          weight_kg: number
        }
        Update: {
          batch_code?: string | null
          block_loc?: string | null
          cost_basis?: number
          created_at?: string | null
          id?: string
          lab_results?: Json
          remarks?: string | null
          sacks?: number | null
          supplier?: string
          transaction_date?: string
          truck_plate?: string | null
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
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          role?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      usage: {
        Row: {
          batch_id: string
          created_at: string | null
          destination: string
          id: string
          remarks: string | null
          snapshot_location: string | null
          snapshot_price: number | null
          transaction_date: string
          weight_kg: number
        }
        Insert: {
          batch_id: string
          created_at?: string | null
          destination: string
          id?: string
          remarks?: string | null
          snapshot_location?: string | null
          snapshot_price?: number | null
          transaction_date: string
          weight_kg: number
        }
        Update: {
          batch_id?: string
          created_at?: string | null
          destination?: string
          id?: string
          remarks?: string | null
          snapshot_location?: string | null
          snapshot_price?: number | null
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
        ]
      }
    }
    Views: {
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
        ]
      }
    }
    Functions: {
      set_audit_comment: { Args: { comment: string }; Returns: undefined }
    }
    Enums: {
      batch_status: "STORED" | "IN-USE" | "CLOSED" | "FEED"
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
      batch_status: ["STORED", "IN-USE", "CLOSED", "FEED"],
    },
  },
} as const
