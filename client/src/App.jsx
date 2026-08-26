import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import { Spinner } from './components/ui';

import Login from './pages/Login';
import StudentDashboard from './pages/student/Dashboard';
import StudentSubject from './pages/student/SubjectDetail';
import FacultyDashboard from './pages/faculty/Dashboard';
import TakeAttendance from './pages/faculty/TakeAttendance';
import SubjectReport from './pages/faculty/SubjectReport';
import Timetable from './pages/timetable/Timetable';
import ManageTimetable from './pages/admin/ManageTimetable';
import AdminHome from './pages/admin/AdminHome';
import People from './pages/admin/People';
import StudentProfile from './pages/admin/StudentProfile';
import StudentLeave from './pages/student/Leave';
import Notes from './pages/notes/Notes';
import Exams from './pages/exams/Exams';
import Academics from './pages/admin/Academics';
import Swaps from './pages/swaps/Swaps';

function Protected({ roles, children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Restoring your session" />;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

/**
 * '/' resolves to the right home screen for the signed-in role. An admin lands
 * on the administration console, not a list of classes to teach.
 */
function RoleHome() {
  const { user } = useAuth();
  if (user?.role === 'student') return <StudentDashboard />;
  if (user?.role === 'admin') return <AdminHome />;
  return <FacultyDashboard />;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <Spinner label="Loading" /> : user ? <Navigate to="/" replace /> : <Login />}
      />

      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<RoleHome />} />

        <Route
          path="subject/:subjectId"
          element={
            <Protected roles={['student']}>
              <StudentSubject />
            </Protected>
          }
        />

        <Route
          path="faculty/subject/:subjectId/take"
          element={
            <Protected roles={['faculty', 'admin']}>
              <TakeAttendance />
            </Protected>
          }
        />
        <Route
          path="faculty/subject/:subjectId/report"
          element={
            <Protected roles={['faculty', 'admin']}>
              <SubjectReport />
            </Protected>
          }
        />

        {/* Course material: lecturers publish, their class downloads. */}
        <Route path="notes" element={<Notes />} />

        {/* Exam timetables: the office publishes, everyone else reads. */}
        <Route path="exams" element={<Exams />} />

        {/* A student tells the office why they were away. */}
        <Route
          path="leave"
          element={
            <Protected roles={['student']}>
              <StudentLeave />
            </Protected>
          }
        />

        {/* Administration */}
        <Route
          path="admin/people"
          element={
            <Protected roles={['admin']}>
              <People />
            </Protected>
          }
        />
        {/* One student: attendance beside the leave applications they sent. */}
        <Route
          path="admin/students/:studentId"
          element={
            <Protected roles={['admin']}>
              <StudentProfile />
            </Protected>
          }
        />
        <Route
          path="admin/academics"
          element={
            <Protected roles={['admin']}>
              <Academics />
            </Protected>
          }
        />
        {/* Read-only oversight: admins can inspect any subject's register */}
        <Route
          path="admin/subjects"
          element={
            <Protected roles={['admin']}>
              <FacultyDashboard />
            </Protected>
          }
        />

        {/* Timetable — readable by everyone, managed by admin */}
        <Route path="timetable" element={<Timetable />} />
        <Route
          path="timetable/manage"
          element={
            <Protected roles={['admin']}>
              <ManageTimetable />
            </Protected>
          }
        />
        <Route
          path="swaps"
          element={
            <Protected roles={['faculty', 'admin']}>
              <Swaps />
            </Protected>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
