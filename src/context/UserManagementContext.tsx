import { createContext, useContext, useState, ReactNode } from "react";

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  password: string;
  username: string;
  verified: boolean;
  level: string;
  joinDate: string;
  createdAt?: string;
  totalBets: number;
  totalWinnings: number;
  accountBalance: number;
  withdrawalActivated?: boolean;
  withdrawalActivationDate?: string | null;
  betnexaId?: string | null;
  isBanned?: boolean;
}

interface UserManagementContextType {
  users: User[];
  updateUser: (userId: string, userData: Partial<User>) => void;
  getUser: (userId: string) => User | undefined;
  addUser: (user: User) => void;
  getAllUsers: () => User[];
  setAllUsers: (users: User[]) => void;
  fetchUsersFromBackend: (phone?: string) => Promise<void>;
}

const UserManagementContext = createContext<UserManagementContextType | undefined>(undefined);

export function UserManagementProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<User[]>([]);

  const updateUser = (userId: string, userData: Partial<User>) => {
    setUsers((prev) =>
      prev.map((user) => (user.id === userId ? { ...user, ...userData } : user))
    );
  };

  const getUser = (userId: string) => {
    return users.find((user) => user.id === userId);
  };

  const addUser = (user: User) => {
    setUsers((prev) => [...prev, user]);
  };

  const getAllUsers = () => {
    return users;
  };

  const setAllUsers = (newUsers: User[]) => {
    setUsers(newUsers);
  };

  const fetchUsersFromBackend = async (phone?: string) => {
    try {
      console.log('ðŸ“¥ Fetching users from backend...');
      const apiUrl = import.meta.env.VITE_API_URL || 'https://betnexabackend.co.ke';
      const queryParam = phone ? `?phone=${encodeURIComponent(phone)}` : '';
      const response = await fetch(`${apiUrl}/api/admin/users${queryParam}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();

      if (data.success && data.users && Array.isArray(data.users)) {
        console.log(`âœ… Received ${data.users.length} users from backend`);
        
        // Map database fields to User interface
        const mappedUsers: User[] = data.users.map((u: any) => {
          // Handle both is_verified and email_verified field names
          const isVerified = u.is_verified !== undefined ? u.is_verified : (u.email_verified || false);
          
          return {
            id: u.id || '',
            name: u.name || u.username || u.phone_number || 'Unknown User',
            email: u.email || '',
            phone: u.phone_number || '',
            password: u.password || '',
            username: u.username || u.phone_number || '',
            verified: isVerified,
            level: u.is_admin ? 'Admin' : 'Regular User',
            joinDate: u.created_at ? new Date(u.created_at).toLocaleDateString() : new Date().toLocaleDateString(),
            createdAt: u.created_at || undefined,
            totalBets: parseInt(u.total_bets || 0),
            totalWinnings: parseFloat(u.total_winnings || 0),
            accountBalance: parseFloat(u.account_balance || 0),
            withdrawalActivated: u.withdrawal_activated || false,
            withdrawalActivationDate: u.withdrawal_activation_date || null,
            betnexaId: u.betnexa_id || null,
            isBanned: u.is_banned || false,
          };
        });

        console.log(`âœ… Mapped ${mappedUsers.length} users successfully`);
        setAllUsers(mappedUsers);
      } else {
        console.warn('âš ï¸  No users data in response or response not successful');
        console.log('Response data:', data);
        console.warn('âŒ Failed to fetch users - ensure admin phone is passed');
      }
    } catch (error) {
      console.error('âŒ Error fetching users from backend:', error);
    }
  };

  return (
    <UserManagementContext.Provider
      value={{ users, updateUser, getUser, addUser, getAllUsers, setAllUsers, fetchUsersFromBackend }}
    >
      {children}
    </UserManagementContext.Provider>
  );
}

export function useUserManagement() {
  const context = useContext(UserManagementContext);
  if (context === undefined) {
    throw new Error("useUserManagement must be used within a UserManagementProvider");
  }
  return context;
}


