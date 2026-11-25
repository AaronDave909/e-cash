import { ActivityFeed } from "../components/Activity";
import { Flows } from "../components/Flows";
import { JournalList } from "../components/Journals";
import { BurstTest, RaceTest } from "../components/LoadTests";
import { PersonaPanel } from "../components/PersonaPanel";
import { RailChaos } from "../components/RailChaos";
import { UserCards } from "../components/UserCards";
import { Panel } from "../components/ui";

export function UsersView() {
  return (
    <div className="grid">
      <Panel title="Personas">
        <PersonaPanel />
      </Panel>
      <Panel title="Wallets">
        <UserCards />
      </Panel>
      <Panel title="Send money">
        <Flows />
      </Panel>
      <Panel title="Live activity">
        <ActivityFeed />
      </Panel>
      <Panel title="Ledger journal">
        <JournalList ms={1500} />
      </Panel>
      <Panel title="Burst traffic">
        <BurstTest />
      </Panel>
      <Panel title="Double-spend race">
        <RaceTest />
      </Panel>
      <Panel title="Bank-rail degradation">
        <RailChaos />
      </Panel>
    </div>
  );
}
