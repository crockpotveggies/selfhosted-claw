import { useEffect, useState } from 'react';
import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CRow,
  CTable,
  CTableBody,
  CTableDataCell,
  CTableHead,
  CTableHeaderCell,
  CTableRow,
} from '@coreui/react';
import { ArrowClockwise, StopCircle } from 'react-bootstrap-icons';

import { apiFetch } from '../admin/api';

interface ResearchJob {
  id: string;
  status: string;
  researchSubstate: string | null;
  createdAt: string;
  updatedAt: string;
  summary: string;
  sourceThreadId: string | null;
  principalDisplayName: string;
  spend: { searchCalls?: number; fetchCalls?: number } | null;
  progress: {
    topicSlug?: string;
    reportPath?: string;
  } | null;
}

interface ResearchSummary {
  date: string;
  dailyQuota: number;
  usedCalls: number;
  remainingCalls: number;
  activeRuns: number;
}

export function ResearchPage() {
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [summary, setSummary] = useState<ResearchSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await apiFetch<{
        jobs: ResearchJob[];
        summary: ResearchSummary;
      }>('/api/admin/research/jobs');
      setJobs(result.jobs);
      setSummary(result.summary);
    } catch {
      setJobs([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const cancelJob = async (jobId: string) => {
    setCancellingId(jobId);
    try {
      await apiFetch(
        `/api/admin/research/jobs/${encodeURIComponent(jobId)}/cancel`,
        {
          method: 'POST',
        },
      );
      await load();
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <CCard>
      <CCardHeader className="d-flex justify-content-between align-items-center">
        <strong>Deep Research Jobs</strong>
        <CButton
          size="sm"
          color="secondary"
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <ArrowClockwise size={14} className="me-1" />
          {loading ? 'Loading...' : 'Refresh'}
        </CButton>
      </CCardHeader>
      <CCardBody className="p-0">
        {summary ? (
          <div className="p-3 border-bottom">
            <CRow className="g-3">
              <CCol md={3} sm={6}>
                <div className="small text-body-secondary">Today's quota</div>
                <div className="fw-semibold">
                  {summary.usedCalls} / {summary.dailyQuota}
                </div>
              </CCol>
              <CCol md={3} sm={6}>
                <div className="small text-body-secondary">Remaining</div>
                <div className="fw-semibold">{summary.remainingCalls}</div>
              </CCol>
              <CCol md={3} sm={6}>
                <div className="small text-body-secondary">Active runs</div>
                <div className="fw-semibold">{summary.activeRuns}</div>
              </CCol>
              <CCol md={3} sm={6}>
                <div className="small text-body-secondary">Date</div>
                <div className="fw-semibold">{summary.date}</div>
              </CCol>
            </CRow>
          </div>
        ) : null}
        <CTable hover responsive className="mb-0">
          <CTableHead>
            <CTableRow>
              <CTableHeaderCell className="bg-body-tertiary">
                Status
              </CTableHeaderCell>
              <CTableHeaderCell className="bg-body-tertiary">
                Summary
              </CTableHeaderCell>
              <CTableHeaderCell className="bg-body-tertiary">
                Principal
              </CTableHeaderCell>
              <CTableHeaderCell className="bg-body-tertiary">
                Spend
              </CTableHeaderCell>
              <CTableHeaderCell className="bg-body-tertiary">
                Report
              </CTableHeaderCell>
              <CTableHeaderCell className="bg-body-tertiary text-end">
                Action
              </CTableHeaderCell>
            </CTableRow>
          </CTableHead>
          <CTableBody>
            {jobs.map((job) => (
              <CTableRow key={job.id}>
                <CTableDataCell>
                  <CBadge
                    color={
                      job.status === 'succeeded'
                        ? 'success'
                        : job.status === 'failed_terminal'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {job.researchSubstate || job.status}
                  </CBadge>
                </CTableDataCell>
                <CTableDataCell>
                  <div>{job.summary}</div>
                  <div className="small text-body-secondary">{job.id}</div>
                </CTableDataCell>
                <CTableDataCell>{job.principalDisplayName}</CTableDataCell>
                <CTableDataCell className="small text-body-secondary">
                  {job.spend
                    ? `${job.spend.searchCalls || 0} searches - ${job.spend.fetchCalls || 0} fetches`
                    : '-'}
                </CTableDataCell>
                <CTableDataCell className="small text-body-secondary">
                  {job.progress?.reportPath || '-'}
                </CTableDataCell>
                <CTableDataCell className="text-end">
                  <CButton
                    size="sm"
                    color="danger"
                    variant="outline"
                    disabled={cancellingId === job.id}
                    onClick={() => void cancelJob(job.id)}
                  >
                    <StopCircle size={14} className="me-1" />
                    Cancel
                  </CButton>
                </CTableDataCell>
              </CTableRow>
            ))}
          </CTableBody>
        </CTable>
      </CCardBody>
    </CCard>
  );
}
