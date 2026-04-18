import { useEffect, useState } from 'react';
import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CTable,
  CTableBody,
  CTableDataCell,
  CTableHead,
  CTableHeaderCell,
  CTableRow,
} from '@coreui/react';
import {
  ArrowClockwise,
  PlayCircleFill,
  PauseCircleFill,
  CheckCircleFill,
  ClockFill,
} from 'react-bootstrap-icons';

import { apiFetch } from '../admin/api';
import { PaginatedTable } from '../components/PaginatedTable';

interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'success';
    case 'paused':
      return 'warning';
    case 'completed':
      return 'secondary';
    default:
      return 'info';
  }
}

function statusIcon(status: string) {
  switch (status) {
    case 'active':
      return <PlayCircleFill size={12} className="me-1" />;
    case 'paused':
      return <PauseCircleFill size={12} className="me-1" />;
    case 'completed':
      return <CheckCircleFill size={12} className="me-1" />;
    default:
      return <ClockFill size={12} className="me-1" />;
  }
}

function scheduleLabel(task: ScheduledTask): string {
  if (task.schedule_type === 'cron') return `cron: ${task.schedule_value}`;
  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (ms >= 3600000) return `every ${Math.round(ms / 3600000)}h`;
    if (ms >= 60000) return `every ${Math.round(ms / 60000)}m`;
    return `every ${Math.round(ms / 1000)}s`;
  }
  return 'once';
}

function timeAgo(timestamp: string | null): string {
  if (!timestamp) return '—';
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  if (diffMs < 0) {
    // Future
    const mins = Math.floor(-diffMs / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.floor(hours / 24);
    return `in ${days}d`;
  }
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TasksPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setTasks(await apiFetch<ScheduledTask[]>('/api/admin/tasks'));
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const runTaskNow = async (taskId: string) => {
    setActionError('');
    setRunningTaskId(taskId);
    try {
      await apiFetch<{ ok: boolean; message: string }>(
        `/api/admin/tasks/${encodeURIComponent(taskId)}/run`,
        { method: 'POST' },
      );
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to run task',
      );
    } finally {
      setRunningTaskId(null);
    }
  };

  const startEditing = (task: ScheduledTask) => {
    setActionError('');
    setEditingTaskId(task.id);
    setEditedPrompt(task.prompt);
  };

  const cancelEditing = () => {
    setEditingTaskId(null);
    setEditedPrompt('');
  };

  const savePrompt = async (taskId: string) => {
    setActionError('');
    setSavingTaskId(taskId);
    try {
      await apiFetch<{ ok: boolean; task: ScheduledTask }>(
        `/api/admin/tasks/${encodeURIComponent(taskId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ prompt: editedPrompt }),
        },
      );
      cancelEditing();
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to save task prompt',
      );
    } finally {
      setSavingTaskId(null);
    }
  };

  const deletePromptTask = async (taskId: string) => {
    if (!window.confirm('Delete this scheduled task?')) return;
    setActionError('');
    setDeletingTaskId(taskId);
    try {
      await apiFetch<{ ok: boolean; message: string }>(
        `/api/admin/tasks/${encodeURIComponent(taskId)}`,
        { method: 'DELETE' },
      );
      if (expandedId === taskId) setExpandedId(null);
      if (editingTaskId === taskId) cancelEditing();
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to delete task',
      );
    } finally {
      setDeletingTaskId(null);
    }
  };

  const activeTasks = tasks.filter((t) => t.status === 'active');
  const pausedTasks = tasks.filter((t) => t.status === 'paused');
  const completedTasks = tasks.filter((t) => t.status === 'completed');

  return (
    <CCard>
      <CCardHeader className="d-flex justify-content-between align-items-center">
        <div className="d-flex align-items-center gap-2">
          <ClockFill size={16} />
          <strong>Scheduled Tasks</strong>
          <CBadge color="success" size="sm">
            {activeTasks.length} active
          </CBadge>
          {pausedTasks.length > 0 && (
            <CBadge color="warning" size="sm">
              {pausedTasks.length} paused
            </CBadge>
          )}
          {completedTasks.length > 0 && (
            <CBadge color="secondary" size="sm">
              {completedTasks.length} done
            </CBadge>
          )}
        </div>
        <CButton
          size="sm"
          color="secondary"
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          <ArrowClockwise size={14} className="me-1" />
          {loading ? 'Loading...' : 'Refresh'}
        </CButton>
      </CCardHeader>
      <CCardBody className="p-0">
        {actionError && (
          <div className="px-3 py-2 text-danger small border-bottom">
            {actionError}
          </div>
        )}
        <PaginatedTable
          items={tasks}
          renderTable={(pageItems) => (
            <CTable hover responsive align="middle" className="mb-0">
              <CTableHead className="text-nowrap">
                <CTableRow>
                  <CTableHeaderCell className="bg-body-tertiary text-center" style={{ width: 90 }}>
                    Status
                  </CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">
                    Group
                  </CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">
                    Prompt
                  </CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">
                    Schedule
                  </CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">
                    Next Run
                  </CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">
                    Last Run
                  </CTableHeaderCell>
                </CTableRow>
              </CTableHead>
              <CTableBody>
                {pageItems.length === 0 ? (
                  <CTableRow>
                    <CTableDataCell
                      colSpan={6}
                      className="text-center text-body-secondary py-4"
                    >
                      {loading
                        ? 'Loading tasks...'
                        : 'No scheduled tasks'}
                    </CTableDataCell>
                  </CTableRow>
                ) : (
                  pageItems.map((task) => (
                    <>
                      <CTableRow
                        key={task.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() =>
                          setExpandedId(
                            expandedId === task.id ? null : task.id,
                          )
                        }
                      >
                        <CTableDataCell className="text-center">
                          <CBadge
                            size="sm"
                            color={statusColor(task.status)}
                          >
                            {statusIcon(task.status)}
                            {task.status}
                          </CBadge>
                        </CTableDataCell>
                        <CTableDataCell>
                          <div className="fw-semibold small">
                            {task.group_folder}
                          </div>
                        </CTableDataCell>
                        <CTableDataCell>
                          <div
                            className="small text-truncate"
                            style={{ maxWidth: 280 }}
                          >
                            {task.prompt}
                          </div>
                        </CTableDataCell>
                        <CTableDataCell>
                          <div className="small">
                            <CBadge
                              color="dark"
                              size="sm"
                              className="me-1"
                            >
                              {task.schedule_type}
                            </CBadge>
                            {scheduleLabel(task)}
                          </div>
                        </CTableDataCell>
                        <CTableDataCell>
                          <div className="small text-body-secondary text-nowrap">
                            {timeAgo(task.next_run)}
                          </div>
                        </CTableDataCell>
                        <CTableDataCell>
                          <div className="small text-body-secondary text-nowrap">
                            {timeAgo(task.last_run)}
                          </div>
                        </CTableDataCell>
                      </CTableRow>
                      {expandedId === task.id && (
                        <CTableRow key={`${task.id}-detail`}>
                          <CTableDataCell
                            colSpan={6}
                            className="bg-body-tertiary"
                          >
                            <div className="small p-2">
                              <div className="mb-2">
                                <strong>ID:</strong>{' '}
                                <code>{task.id}</code>
                              </div>
                              <div className="mb-3">
                                <CButton
                                  size="sm"
                                  color="primary"
                                  disabled={runningTaskId === task.id}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void runTaskNow(task.id);
                                  }}
                                >
                                  <PlayCircleFill size={14} className="me-1" />
                                  {runningTaskId === task.id
                                    ? 'Queueing...'
                                    : 'Run now'}
                                </CButton>
                                <CButton
                                  size="sm"
                                  color="secondary"
                                  variant="outline"
                                  className="ms-2"
                                  disabled={deletingTaskId === task.id}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    startEditing(task);
                                  }}
                                >
                                  Edit prompt
                                </CButton>
                                <CButton
                                  size="sm"
                                  color="danger"
                                  variant="outline"
                                  className="ms-2"
                                  disabled={deletingTaskId === task.id}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void deletePromptTask(task.id);
                                  }}
                                >
                                  {deletingTaskId === task.id
                                    ? 'Deleting...'
                                    : 'Delete'}
                                </CButton>
                              </div>
                              <div className="mb-2">
                                <strong>Full prompt:</strong>
                                {editingTaskId === task.id ? (
                                  <>
                                    <textarea
                                      className="form-control mt-1"
                                      rows={6}
                                      value={editedPrompt}
                                      onChange={(event) =>
                                        setEditedPrompt(event.target.value)
                                      }
                                      onClick={(event) =>
                                        event.stopPropagation()
                                      }
                                    />
                                    <div className="mt-2">
                                      <CButton
                                        size="sm"
                                        color="primary"
                                        disabled={savingTaskId === task.id}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void savePrompt(task.id);
                                        }}
                                      >
                                        {savingTaskId === task.id
                                          ? 'Saving...'
                                          : 'Save prompt'}
                                      </CButton>
                                      <CButton
                                        size="sm"
                                        color="secondary"
                                        variant="ghost"
                                        className="ms-2"
                                        disabled={savingTaskId === task.id}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          cancelEditing();
                                        }}
                                      >
                                        Cancel
                                      </CButton>
                                    </div>
                                  </>
                                ) : (
                                  <pre
                                    className="mt-1 mb-0"
                                    style={{
                                      whiteSpace: 'pre-wrap',
                                      fontSize: '0.8rem',
                                    }}
                                  >
                                    {task.prompt}
                                  </pre>
                                )}
                              </div>
                              {task.script && (
                                <div className="mb-2">
                                  <strong>Script:</strong>
                                  <pre
                                    className="mt-1 mb-0"
                                    style={{
                                      whiteSpace: 'pre-wrap',
                                      fontSize: '0.8rem',
                                    }}
                                  >
                                    {task.script}
                                  </pre>
                                </div>
                              )}
                              <div className="mb-2">
                                <strong>Context mode:</strong>{' '}
                                {task.context_mode}
                              </div>
                              <div className="mb-2">
                                <strong>Chat JID:</strong>{' '}
                                <code>{task.chat_jid}</code>
                              </div>
                              <div className="mb-2">
                                <strong>Created:</strong>{' '}
                                {new Date(
                                  task.created_at,
                                ).toLocaleString()}
                              </div>
                              {task.last_result && (
                                <div>
                                  <strong>Last result:</strong>
                                  <pre
                                    className="mt-1 mb-0"
                                    style={{
                                      whiteSpace: 'pre-wrap',
                                      fontSize: '0.8rem',
                                      maxHeight: 200,
                                      overflow: 'auto',
                                    }}
                                  >
                                    {task.last_result}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </CTableDataCell>
                        </CTableRow>
                      )}
                    </>
                  ))
                )}
              </CTableBody>
            </CTable>
          )}
        />
      </CCardBody>
    </CCard>
  );
}
