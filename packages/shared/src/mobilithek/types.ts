import type { StationRecord, TariffSummary } from "../domain/types";

export type ParsedStaticFeed = {
  stations: StationRecord[];
};

export type ParsedDynamicUpdate = {
  chargePointId: string;
  status: string;
  tariffs: TariffSummary[];
  lastUpdatedAt: string | null;
};

export type ParsedDynamicFeed = {
  updates: ParsedDynamicUpdate[];
};
