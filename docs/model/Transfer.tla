---- MODULE Transfer ----
EXTENDS Naturals, FiniteSets
CONSTANTS Transfers, Amount, Opening, LOCKED

VARIABLES status, posted, rejected, reversed, wallet, recv, seen
vars == <<status, posted, rejected, reversed, wallet, recv, seen>>

Init == /\ status = [t \in Transfers |-> "none"]
        /\ posted = [t \in Transfers |-> FALSE]
        /\ rejected = [t \in Transfers |-> FALSE]
        /\ reversed = [t \in Transfers |-> FALSE]
        /\ wallet = Opening /\ recv = 0
        /\ seen = [t \in Transfers |-> -1]  \* balance read by an unlocked check

Create(t) == /\ status[t] = "none" /\ status' = [status EXCEPT ![t] = "PENDING"]
             /\ UNCHANGED <<posted, rejected, reversed, wallet, recv, seen>>

\* Ledger: lock wallet row, read balance, debit in one transaction.
PostLocked(t) == /\ LOCKED /\ status[t] = "PENDING" /\ ~posted[t] /\ ~rejected[t]
   /\ IF wallet >= Amount
        THEN /\ posted' = [posted EXCEPT ![t] = TRUE]
             /\ wallet' = wallet - Amount /\ recv' = recv + Amount
             /\ UNCHANGED rejected
        ELSE /\ rejected' = [rejected EXCEPT ![t] = TRUE]
             /\ UNCHANGED <<posted, wallet, recv>>
   /\ UNCHANGED <<status, reversed, seen>>

\* Without the row lock: the balance check and the debit are separate steps.
Check(t) == /\ ~LOCKED /\ status[t] = "PENDING" /\ ~posted[t] /\ ~rejected[t] /\ seen[t] = -1
   /\ seen' = [seen EXCEPT ![t] = wallet]
   /\ UNCHANGED <<status, posted, rejected, reversed, wallet, recv>>
PostUnlocked(t) == /\ ~LOCKED /\ seen[t] # -1 /\ ~posted[t] /\ ~rejected[t]
   /\ IF seen[t] >= Amount
        THEN /\ posted' = [posted EXCEPT ![t] = TRUE]
             /\ wallet' = wallet - Amount /\ recv' = recv + Amount
             /\ UNCHANGED rejected
        ELSE /\ rejected' = [rejected EXCEPT ![t] = TRUE]
             /\ UNCHANGED <<posted, wallet, recv>>
   /\ UNCHANGED <<status, reversed, seen>>

\* Transfer service records the ledger outcome (possibly after a crash + reconciler retry).
Complete(t) == /\ status[t] = "PENDING" /\ posted[t]
   /\ status' = [status EXCEPT ![t] = "COMPLETED"]
   /\ UNCHANGED <<posted, rejected, reversed, wallet, recv, seen>>
Fail(t) == /\ status[t] = "PENDING" /\ rejected[t]
   /\ status' = [status EXCEPT ![t] = "FAILED"]
   /\ UNCHANGED <<posted, rejected, reversed, wallet, recv, seen>>
Reverse(t) == /\ status[t] = "COMPLETED" /\ recv >= Amount
   /\ status' = [status EXCEPT ![t] = "REVERSED"]
   /\ reversed' = [reversed EXCEPT ![t] = TRUE]
   /\ wallet' = wallet + Amount /\ recv' = recv - Amount
   /\ UNCHANGED <<posted, rejected, seen>>

Done == /\ \A t \in Transfers : status[t] \in {"COMPLETED", "FAILED", "REVERSED"}
        /\ UNCHANGED vars

Next == \E t \in Transfers : Create(t) \/ PostLocked(t) \/ Check(t) \/ PostUnlocked(t)
                            \/ Complete(t) \/ Fail(t) \/ Reverse(t)
        \/ Done

NoOverdraft == wallet >= 0
LedgerBalanced == wallet + recv = Opening
CompletedHasJournal == \A t \in Transfers : status[t] = "COMPLETED" => posted[t] /\ ~reversed[t]
FailedHasNoJournal == \A t \in Transfers : status[t] = "FAILED" => ~posted[t]
ReversedWasPosted == \A t \in Transfers : status[t] = "REVERSED" => posted[t] /\ reversed[t]
====
