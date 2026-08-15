import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Trash2, Edit2, Save, X, Clock, CheckCircle, AlertCircle, Zap } from "lucide-react";
import { formatTimeInEAT } from "@/lib/timezoneFormatter";

interface MatchEvent {
  id: string;
  event_type: "kickoff" | "halftime" | "resume" | "score_update" | "end";
  scheduled_at: string;
  executed_at: string | null;
  event_data: Record<string, any> | null;
  is_active: boolean;
}

interface MatchEventEditorProps {
  gameId: string;
  gameName: string;
  kickoffTime: string;
  onClose: () => void;
  adminPhone: string; // Admin's phone number for API calls
}

export function MatchEventEditor({ gameId, gameName, kickoffTime, onClose, adminPhone }: MatchEventEditorProps) {
  const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

  const toEATDate = (isoOrDate: string | Date) => {
    const base = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    return new Date(base.getTime() + EAT_OFFSET_MS);
  };

  const getEatDateParts = (isoOrDate: string | Date) => {
    const eatDate = toEATDate(isoOrDate);
    return {
      year: eatDate.getUTCFullYear(),
      month: eatDate.getUTCMonth() + 1,
      day: eatDate.getUTCDate(),
      hour: eatDate.getUTCHours(),
      minute: eatDate.getUTCMinutes(),
    };
  };

  const pad2 = (value: number) => String(value).padStart(2, "0");

  const getEatTimeFromIso = (isoOrDate: string | Date) => {
    const parts = getEatDateParts(isoOrDate);
    return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  };

  const getEatDateLabelFromIso = (isoOrDate: string | Date) => {
    const parts = getEatDateParts(isoOrDate);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  };

  const getDefaultEatDateTime = (offsetMinutes = 0) => {
    const kickoff = new Date(kickoffTime);
    if (isNaN(kickoff.getTime())) {
      const now = new Date();
      const eatNow = new Date(now.getTime() + EAT_OFFSET_MS + offsetMinutes * 60 * 1000);
      return {
        date: `${eatNow.getUTCFullYear()}-${String(eatNow.getUTCMonth() + 1).padStart(2, '0')}-${String(eatNow.getUTCDate()).padStart(2, '0')}`,
        time: `${String(eatNow.getUTCHours()).padStart(2, '0')}:${String(eatNow.getUTCMinutes()).padStart(2, '0')}`,
      };
    }

    const eatKickoff = new Date(kickoff.getTime() + EAT_OFFSET_MS + offsetMinutes * 60 * 1000);
    return {
      date: `${eatKickoff.getUTCFullYear()}-${String(eatKickoff.getUTCMonth() + 1).padStart(2, '0')}-${String(eatKickoff.getUTCDate()).padStart(2, '0')}`,
      time: `${String(eatKickoff.getUTCHours()).padStart(2, '0')}:${String(eatKickoff.getUTCMinutes()).padStart(2, '0')}`,
    };
  };

  const getDefaultEventTime = () => getDefaultEatDateTime(46).time;

  const buildUtcIsoFromEatDateTime = (eatDate: string, eatTime: string) => {
    const [year, month, day] = eatDate.split('-').map(Number);
    const [hourStr, minuteStr] = eatTime.split(':');
    const eatHour = Number(hourStr);
    const eatMinute = Number(minuteStr);

    const utcMs = Date.UTC(year, month - 1, day, eatHour - 3, eatMinute, 0, 0);
    return new Date(utcMs).toISOString();
  };

  const getDefaultFormValues = () => {
    const kickoffDateTime = getDefaultEatDateTime(0);
    return {
      eventType: 'score_update' as MatchEvent['event_type'],
      minute: 45,
      homeScore: 0,
      awayScore: 0,
      eventDate: kickoffDateTime.date,
      eventTime: kickoffDateTime.time,
    };
  };

  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [executionMessage, setExecutionMessage] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingEvent, setEditingEvent] = useState<MatchEvent | null>(null);
  const [showPreviousEvents, setShowPreviousEvents] = useState(false);
  const [formData, setFormData] = useState({
    ...getDefaultFormValues(),
  });

  const pendingEvents = events.filter((event) => !event.executed_at && event.is_active);
  const previousEvents = events.filter((event) => !!event.executed_at);
  const displayedEvents = showPreviousEvents ? previousEvents : pendingEvents;

  // Load events on mount
  useEffect(() => {
    const initialize = async () => {
      console.log('ðŸ”„ [MatchEventEditor] Component mounted, adminPhone:', adminPhone ? adminPhone.substring(0, 5) + '...' : 'MISSING');
      if (adminPhone) {
        await executePendingEvents();
      }
      await loadEvents();
    };

    initialize();
  }, [gameId, adminPhone]);

  // Admin phone is passed as prop from AdminPortal
  const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexabackend.co.ke';

  const executePendingEvents = async () => {
    if (!adminPhone) return;
    try {
      const response = await fetch(`${apiUrl}/api/admin/match-events/${gameId}/execute-pending?phone=${encodeURIComponent(adminPhone)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.warn("âš ï¸ Could not execute due events", data);
        setErrorMessage(data?.error || "Failed to execute pending events");
        return;
      }

      if (data.eventsExecuted > 0) {
        setExecutionMessage(`Executed ${data.eventsExecuted} due event(s)`);
      } else {
        setExecutionMessage("No due events were pending execution.");
      }
    } catch (error) {
      console.error("Error executing pending events:", error);
      setErrorMessage(`Error executing pending events: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const loadEvents = async () => {
    try {
      setLoading(true);
      setErrorMessage(null);
      setExecutionMessage(null);
      
      if (!adminPhone) {
        console.error("âŒ Admin phone not provided to MatchEventEditor");
        setErrorMessage("Admin phone is missing. Please ensure you're logged in as admin.");
        setLoading(false);
        return;
      }

      const url = `${apiUrl}/api/admin/match-events/${gameId}?phone=${encodeURIComponent(adminPhone)}`;
      console.log("ðŸ“‹ Fetching events from:", url);
      
      const response = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      console.log("Response status:", response.status);

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        // Not JSON - likely HTML error page
        const text = await response.text();
        console.error("Non-JSON response:", text.substring(0, 200));
        setErrorMessage(`API Error (${response.status}): Expected JSON but got ${contentType || "HTML"}`);
        return;
      }

      const data = await response.json();
      console.log("Events loaded:", data);

      if (response.ok) {
        setEvents(data.events || []);
      } else {
        setErrorMessage(data?.error || `Failed to load match events (${response.status})`);
      }
    } catch (error) {
      console.error("Error loading events:", error);
      setErrorMessage(`Error loading events: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAddEvent = async () => {
    try {
      setSubmitting(true);
      setErrorMessage(null);
      
      if (!adminPhone) {
        console.error("âŒ Admin phone not provided");
        setErrorMessage("Admin phone is missing. Please ensure you're logged in as admin.");
        setSubmitting(false);
        return;
      }

      let eventUtcIso: string;

      if (formData.eventType === "score_update") {
        const kickoffMs = new Date(kickoffTime).getTime();
        if (isNaN(kickoffMs)) {
          setErrorMessage("Invalid kickoff time. Cannot schedule score update.");
          setSubmitting(false);
          return;
        }
        eventUtcIso = new Date(kickoffMs + formData.minute * 60 * 1000).toISOString();
        console.log("ðŸŽ¯ Creating score_update event at minute", formData.minute, "â†’ UTC:", eventUtcIso);
      } else {
        if (!formData.eventDate || !formData.eventTime) {
          setErrorMessage("Please select both event date and time in EAT.");
          setSubmitting(false);
          return;
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(formData.eventDate) || !/^\d{2}:\d{2}$/.test(formData.eventTime)) {
          setErrorMessage("Please use valid EAT date and time values.");
          setSubmitting(false);
          return;
        }

        eventUtcIso = buildUtcIsoFromEatDateTime(formData.eventDate, formData.eventTime);
        console.log("ðŸŽ¯ Creating event:", {
          eventType: formData.eventType,
          eatDate: formData.eventDate,
          eatTime: formData.eventTime,
          utcIso: eventUtcIso,
        });
      }

      const eventData: any = {
        eventType: formData.eventType,
        scheduledAt: eventUtcIso,
        eventData: null,
      };

      if (formData.eventType === "score_update") {
        eventData.eventData = {
          minute: formData.minute,
          homeScore: formData.homeScore,
          awayScore: formData.awayScore,
        };
      }

      const response = await fetch(`${apiUrl}/api/admin/match-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: adminPhone,
          gameId,
          events: [eventData],
        }),
      });

      if (response.ok) {
        await loadEvents();
        setShowAddDialog(false);
        setFormData({
          eventType: "score_update",
          minute: 45,
          homeScore: 0,
          awayScore: 0,
          eventTime: getDefaultEventTime(),
        });
      } else {
        const data = await response.json().catch(() => ({}));
        setErrorMessage(data?.error || "Failed to add event");
      }
    } catch (error) {
      console.error("Error adding event:", error);
      setErrorMessage("Network error while adding event");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteEvent = async (eventId: string) => {
    try {
      const response = await fetch(`${apiUrl}/api/admin/match-events/${eventId}?phone=${encodeURIComponent(adminPhone)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        await loadEvents();
      } else {
        const data = await response.json().catch(() => ({}));
        setErrorMessage(data?.error || "Failed to delete event");
      }
    } catch (error) {
      console.error("Error deleting event:", error);
      setErrorMessage("Network error while deleting event");
    }
  };

  const getEventLabel = (eventType: string): string => {
    const labels: Record<string, string> = {
      kickoff: "Kickoff",
      halftime: "Halftime",
      resume: "Resume 2nd Half",
      score_update: "Score Update",
      end: "End Match",
    };
    return labels[eventType] || eventType;
  };

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case "kickoff":
        return "ðŸŽ¯";
      case "halftime":
        return "â±ï¸";
      case "resume":
        return "â–¶ï¸";
      case "score_update":
        return "âš½";
      case "end":
        return "ðŸ";
      default:
        return "ðŸ“Œ";
    }
  };

  return (
    <div className="space-y-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-foreground">
            Match Events: {gameName}
          </h3>
          <p className="text-xs text-muted-foreground">Showing manually added admin events for this match.</p>
          <p className="text-xs text-muted-foreground">
            Times are entered in EAT and shown in EAT. The system stores timestamps in UTC internally for reliable execution.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {previousEvents.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPreviousEvents((prev) => !prev)}
            >
              {showPreviousEvents ? 'Show Upcoming Events' : `View Previous Events (${previousEvents.length})`}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              await executePendingEvents();
              await loadEvents();
            }}
          >
            Sync Events
          </Button>
          <Button
            variant="hero"
            size="sm"
            onClick={() => setShowAddDialog(true)}
            className="flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            Add Event
          </Button>
        </div>
      </div>
      {executionMessage && (
        <Card className="border-blue-500/30 bg-blue-500/10 p-3">
          <p className="text-sm text-blue-100">{executionMessage}</p>
        </Card>
      )}

      {loading ? (
        <Card className="border-primary/30 bg-card/50 p-8 text-center">
          <p className="text-muted-foreground">Loading events...</p>
        </Card>
      ) : events.length === 0 ? (
        <Card className="border-primary/30 bg-card/50 p-8 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No events configured yet. Add events to automate this match.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-[10px]">
                Upcoming: {pendingEvents.length}
              </Badge>
              <Badge variant="secondary" className="text-[10px]">
                Previous: {previousEvents.length}
              </Badge>
            </div>
            {!showPreviousEvents && previousEvents.length > 0 && (
              <p className="text-xs text-muted-foreground">
                View previous events for this game using the button above.
              </p>
            )}
          </div>

          {displayedEvents.length === 0 ? (
            <Card className="border-primary/30 bg-card/50 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                {showPreviousEvents
                  ? 'No previous events found for this game.'
                  : 'No upcoming events found. Add a new event or view previous events.'}
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {displayedEvents.map((event) => {
                const status = event.executed_at
                  ? 'completed'
                  : !event.is_active
                  ? 'failed'
                  : 'pending';

                const statusBadge = {
                  completed: {
                    label: 'Completed',
                    icon: <CheckCircle className="mr-1 h-3 w-3" />,
                    className: 'bg-green-500/10 text-green-400 border-green-500/30',
                  },
                  pending: {
                    label: 'Pending',
                    icon: <Clock className="mr-1 h-3 w-3" />,
                    className: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
                  },
                  failed: {
                    label: 'Failed',
                    icon: <AlertCircle className="mr-1 h-3 w-3" />,
                    className: 'bg-red-500/10 text-red-400 border-red-500/30',
                  },
                }[status];

                return (
                  <Card key={event.id} className="border-primary/20 bg-card/50 p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 flex-1">
                        <span className="text-lg">{getEventIcon(event.event_type)}</span>
                        <div>
                          <p className="font-semibold">{getEventLabel(event.event_type)}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatTimeInEAT(event.scheduled_at)} EAT
                          </p>
                          {event.event_data && (
                            <p className="text-xs text-primary">
                              Min {event.event_data.minute}: {event.event_data.homeScore}-{event.event_data.awayScore}
                            </p>
                          )}
                          {event.executed_at && (
                            <p className="text-xs text-green-400">
                              Completed at {formatTimeInEAT(event.executed_at)} EAT
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={statusBadge.className}>
                          {statusBadge.icon}
                          {statusBadge.label}
                        </Badge>
                        {!event.executed_at && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteEvent(event.id)}
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {errorMessage && (
        <Card className="border-red-500/40 bg-red-500/10 p-3">
          <p className="text-sm text-red-300">{errorMessage}</p>
        </Card>
      )}

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="bg-background border-primary/30">
          <DialogHeader>
            <DialogTitle>Add Match Event</DialogTitle>
            <DialogDescription>Configure an automated event for this match</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Event Type</label>
              <select
                value={formData.eventType}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    eventType: e.target.value as MatchEvent['event_type'],
                  })
                }
                className="mt-1 w-full rounded border border-primary/30 bg-background p-2 text-sm text-foreground"
              >
                <option value="kickoff">Kickoff</option>
                <option value="halftime">Halftime</option>
                <option value="resume">Resume 2nd Half</option>
                <option value="score_update">Score Update</option>
                <option value="end">End Match</option>
              </select>
            </div>

            {formData.eventType !== 'score_update' && (
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-sm font-medium">Event Date (EAT)</label>
                  <Input
                    type="date"
                    value={formData.eventDate}
                    onChange={(e) => setFormData({ ...formData, eventDate: e.target.value })}
                    className="mt-1 bg-background/50 border-primary/30"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Event Time (EAT)</label>
                  <Input
                    type="time"
                    value={formData.eventTime}
                    onChange={(e) => setFormData({ ...formData, eventTime: e.target.value })}
                    className="mt-1 bg-background/50 border-primary/30"
                  />
                </div>
                <p className="md:col-span-2 text-xs text-muted-foreground">
                  This event will trigger at {formData.eventTime || '--:--'} EAT on {formData.eventDate || 'the selected date'}.
                </p>
              </div>
            )}

            {formData.eventType === 'score_update' && (
              <div className="space-y-3">
                <div>
                  <label className="text-sm font-medium">Match Minute</label>
                  <Input
                    type="number"
                    min="1"
                    max="120"
                    value={formData.minute}
                    onChange={(e) => setFormData({ ...formData, minute: parseInt(e.target.value) || 1 })}
                    className="mt-1 bg-background/50 border-primary/30"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Score update is scheduled for minute {formData.minute}.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium">Home Score</label>
                    <Input
                      type="number"
                      min="0"
                      value={formData.homeScore}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          homeScore: parseInt(e.target.value) || 0,
                        })
                      }
                      className="mt-1 bg-background/50 border-primary/30"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Away Score</label>
                    <Input
                      type="number"
                      min="0"
                      value={formData.awayScore}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          awayScore: parseInt(e.target.value) || 0,
                        })
                      }
                      className="mt-1 bg-background/50 border-primary/30"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-2 border-t border-primary/20 pt-4">
              <Button variant="outline" onClick={() => setShowAddDialog(false)} className="flex-1">
                Cancel
              </Button>
              <Button variant="hero" onClick={handleAddEvent} disabled={submitting} className="flex-1">
                <Plus className="mr-2 h-4 w-4" />
                {submitting ? 'Adding...' : 'Add Event'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
